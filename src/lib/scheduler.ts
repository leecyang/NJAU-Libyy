import type { AppEnv } from "../config";
import { flag } from "../config";
import { audit } from "./audit";
import { getAccessToken, refreshCredential } from "./credentials";
import { HttpError } from "./http";
import { deliverDueMail, queueMail } from "./mail";
import { fetchOfficialRooms, submitOfficialReservation, type OfficialMember } from "./official";
import { assertReservation, type Room } from "./validation";

export async function runScheduler(env: AppEnv): Promise<void> {
  const now = Date.now();
  await Promise.all([
    refreshDueCredentials(env, now),
    expireInvitations(env, now),
    prepareReservationTasks(env, now),
    submitReadyReservationTasks(env, now),
    deliverDueMail(env, now),
    cleanupSessions(env, now),
  ]);
}

async function refreshDueCredentials(env: AppEnv, now: number): Promise<void> {
  const cutoff = now - 90 * 60 * 1000;
  const rows = await env.DB.prepare(
    `SELECT user_id FROM official_credentials
      WHERE credential_status IN ('ACTIVE', 'REFRESH_FAILED')
        AND COALESCE(last_refresh_success_at, 0) < ?
      LIMIT 100`,
  ).bind(cutoff).all<{ user_id: string }>();
  await Promise.all(rows.results.map((row) => refreshCredential(env, row.user_id, "SCHEDULED")));
}

async function expireInvitations(env: AppEnv, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE reservation_invitations SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ?",
  ).bind(now).run();
}

async function cleanupSessions(env: AppEnv, now: number): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now).run();
  await env.DB.prepare("DELETE FROM login_attempts WHERE created_at <= ?").bind(now - 24 * 60 * 60 * 1000).run();
}

async function prepareReservationTasks(env: AppEnv, now: number): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, owner_user_id, target_date FROM reservation_tasks
      WHERE status IN ('WAITING_WINDOW', 'WAITING_MEMBERS') LIMIT 50`,
  ).all<{ id: string; owner_user_id: string; target_date: string }>();

  for (const task of rows.results) {
    try {
      const rooms = await fetchOfficialRooms(env, await getAccessToken(env, task.owner_user_id), task.target_date);
      if (rooms.length === 0) continue;
      const pending = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM reservation_invitations WHERE task_id = ? AND status = 'PENDING'",
      ).bind(task.id).first<{ count: number }>();
      const status = Number(pending?.count ?? 0) > 0 ? "WAITING_MEMBERS" : "READY";
      await env.DB.prepare("UPDATE reservation_tasks SET status = ?, updated_at = ? WHERE id = ? AND status IN ('WAITING_WINDOW', 'WAITING_MEMBERS')")
        .bind(status, now, task.id)
        .run();
    } catch {
      // A later scan retries window discovery. Do not guess whether a network error means the window is closed.
    }
  }
}

type ReadyTask = {
  id: string;
  owner_user_id: string;
  target_date: string;
  start_time: string;
  end_time: string;
};

type Candidate = {
  room_id: number;
  room_name_snapshot: string;
};

async function localReservationLimits(env: AppEnv, userId: string, date: string, duration: number): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM((CAST(substr(end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(end_time, 4, 2) AS INTEGER)) -
                         (CAST(substr(start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(start_time, 4, 2) AS INTEGER))), 0) AS minutes
       FROM reservations
      WHERE owner_user_id = ? AND date = ? AND status IN ('SUBMITTED_UNVERIFIED', 'SUCCESS')`,
  ).bind(userId, date).first<{ count: number; minutes: number }>();
  if (Number(row?.count ?? 0) >= 2) throw new HttpError(409, "DAILY_RESERVATION_LIMIT", "每日最多预约 2 次");
  if (Number(row?.minutes ?? 0) + duration > 240) throw new HttpError(409, "DAILY_DURATION_LIMIT", "每日累计预约时长不得超过 240 分钟");
}

async function authorizedMembers(env: AppEnv, taskId: string): Promise<OfficialMember[]> {
  const rows = await env.DB.prepare(
    `SELECT invitee_student_id, invitee_real_name
       FROM reservation_invitations
      WHERE task_id = ? AND status IN ('ACCEPTED', 'AUTO_APPROVED')`,
  ).bind(taskId).all<{ invitee_student_id: string; invitee_real_name: string }>();
  return rows.results.map((row) => ({ userId: row.invitee_student_id, userName: row.invitee_real_name }));
}

function redactedResponse(response: unknown): string {
  return JSON.stringify({
    received: response !== null,
    responseType: Array.isArray(response) ? "array" : typeof response,
  });
}

async function submitReadyReservationTasks(env: AppEnv, now: number): Promise<void> {
  if (!flag(env, "ENABLE_OFFICIAL_RESERVATION_SUBMISSION")) return;
  const tasks = await env.DB.prepare(
    "SELECT id, owner_user_id, target_date, start_time, end_time FROM reservation_tasks WHERE status = 'READY' LIMIT 20",
  ).all<ReadyTask>();

  for (const task of tasks.results) {
    const claimed = await env.DB.prepare(
      "UPDATE reservation_tasks SET status = 'SUBMITTING', attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'READY'",
    ).bind(now, now, task.id).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      const owner = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(task.owner_user_id).first<{ email: string }>();
      const token = await getAccessToken(env, task.owner_user_id);
      const rooms = await fetchOfficialRooms(env, token, task.target_date);
      const members = await authorizedMembers(env, task.id);
      const candidates = await env.DB.prepare(
        "SELECT room_id, room_name_snapshot FROM reservation_task_candidate_rooms WHERE task_id = ? ORDER BY priority",
      ).bind(task.id).all<Candidate>();
      let submitted: { room: Room; response: unknown } | null = null;

      for (const candidate of candidates.results) {
        const room = rooms.find((item) => item.id === candidate.room_id);
        if (!room) continue;
        try {
          const duration = assertReservation(room, {
            date: task.target_date,
            startTime: task.start_time,
            endTime: task.end_time,
            memberCount: members.length,
          }, true);
          await localReservationLimits(env, task.owner_user_id, task.target_date, duration);
          submitted = {
            room,
            response: await submitOfficialReservation(env, token, {
              roomId: room.id,
              date: task.target_date,
              startTime: task.start_time,
              endTime: task.end_time,
              useDescription: "小组学习",
              members,
            }),
          };
          break;
        } catch (error) {
          if (error instanceof HttpError && ["ROOM_DISABLED", "MEMBERS_REQUIRED", "ROOM_DURATION_EXCEEDED", "ROOM_DURATION_TOO_SHORT"].includes(error.code)) continue;
          throw error;
        }
      }
      if (!submitted) throw new HttpError(409, "NO_CANDIDATE_ROOM", "没有满足条件的候选房间");

      const reservationId = crypto.randomUUID();
      const createdAt = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO reservations
            (id, task_id, owner_user_id, room_id, room_name_snapshot, date, start_time, end_time,
             member_snapshot_json, submission_type, status, official_response_json_redacted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTO', 'SUBMITTED_UNVERIFIED', ?, ?, ?)`,
        ).bind(reservationId, task.id, task.owner_user_id, submitted.room.id, submitted.room.name, task.target_date, task.start_time, task.end_time, JSON.stringify(members), redactedResponse(submitted.response), createdAt, createdAt),
        env.DB.prepare("UPDATE reservation_tasks SET status = 'SUCCESS', updated_at = ? WHERE id = ? AND status = 'SUBMITTING'").bind(createdAt, task.id),
        env.DB.prepare("UPDATE reservation_invitations SET status = 'USED', responded_at = COALESCE(responded_at, ?) WHERE task_id = ? AND status IN ('ACCEPTED', 'AUTO_APPROVED')").bind(createdAt, task.id),
      ]);
      await audit(env.DB, { actorUserId: task.owner_user_id, actorType: "SYSTEM", action: "AUTO_RESERVATION_SUBMITTED", targetType: "RESERVATION", targetId: reservationId, result: "SUBMITTED_UNVERIFIED" });
      if (owner) await queueMail(env, owner.email, "AUTO_RESERVATION_SUCCESS", { date: task.target_date, startTime: task.start_time, endTime: task.end_time, roomName: submitted.room.name });
    } catch (error) {
      const message = error instanceof HttpError ? error.message : "自动预约提交失败";
      await env.DB.prepare(
        "UPDATE reservation_tasks SET status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ? AND status = 'SUBMITTING'",
      ).bind(error instanceof HttpError ? error.code : "AUTO_SUBMISSION_FAILED", message, Date.now(), task.id).run();
      const owner = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(task.owner_user_id).first<{ email: string }>();
      if (owner) await queueMail(env, owner.email, "AUTO_RESERVATION_FAILED", { date: task.target_date, startTime: task.start_time, endTime: task.end_time, reason: message });
      await audit(env.DB, { actorUserId: task.owner_user_id, actorType: "SYSTEM", action: "AUTO_RESERVATION_SUBMITTED", targetType: "RESERVATION_TASK", targetId: task.id, result: "FAILED", metadata: { code: error instanceof HttpError ? error.code : "AUTO_SUBMISSION_FAILED" } });
    }
  }
}
