import type { AppEnv } from "../config";
import { flag } from "../config";
import { audit } from "./audit";
import { getAccessToken, getOfficialReservationProfile, refreshCredential } from "./credentials";
import { HttpError } from "./http";
import { deliverDueMail, queueMail } from "./mail";
import {
  acceptOfficialReservation,
  createOfficialQrSignCheckCode,
  fetchOfficialReservationDates,
  fetchOfficialReservationHistory,
  fetchOfficialRoomDetail,
  judgeOfficialReservationUsers,
  signOutOfficialReservation,
  submitOfficialSign,
  submitOfficialReservation,
  verifyOfficialRoomPolicy,
  type OfficialMember,
} from "./official";
import {
  ensureReservationTasks,
  findOfficialRecord,
  localReservationStatus,
  resolveSignDevice,
  shanghaiParts,
  syncOfficialReservationHistory,
  type MemberSnapshot,
} from "./reservations";
import { assertReservation, type Room } from "./validation";

export async function runScheduler(env: AppEnv): Promise<void> {
  const now = Date.now();
  await Promise.all([
    refreshDueCredentials(env, now),
    expireInvitations(env, now),
    expireTeamInvitations(env, now),
    prepareReservationTasks(env, now),
    submitReadyReservationTasks(env, now),
    deliverDueMail(env, now),
    cleanupSessions(env, now),
  ]);
  await syncPendingOfficialReservations(env);
  await submitDueSignTasks(env, now);
  await submitDueSignoutTasks(env, now);
}

async function expireTeamInvitations(env: AppEnv, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE team_invitations SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ?",
  ).bind(now).run();
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
      const dates = await fetchOfficialReservationDates(env, await getAccessToken(env, task.owner_user_id));
      if (!dates.includes(task.target_date)) continue;
      const status = "READY";
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
      WHERE owner_user_id = ? AND date = ? AND status IN ('SUBMITTED_UNVERIFIED', 'SUCCESS', 'SCHEDULED', 'SIGNED_IN', 'SIGNED_OUT')`,
  ).bind(userId, date).first<{ count: number; minutes: number }>();
  if (Number(row?.count ?? 0) >= 2) throw new HttpError(409, "DAILY_RESERVATION_LIMIT", "每日最多预约 2 次");
  if (Number(row?.minutes ?? 0) + duration > 240) throw new HttpError(409, "DAILY_DURATION_LIMIT", "每日累计预约时长不得超过 240 分钟");
}

type AuthorizedMember = OfficialMember & {
  source: "TEAM" | "CONTACT" | "AUTO_JOIN";
  localUserId: string | null;
};

async function authorizedMembers(env: AppEnv, taskId: string): Promise<AuthorizedMember[]> {
  const rows = await env.DB.prepare(
    `SELECT source, member_user_id, official_student_id, official_real_name FROM reservation_task_members WHERE task_id = ?`,
  ).bind(taskId).all<{ source: "TEAM" | "CONTACT" | "AUTO_JOIN"; member_user_id: string | null; official_student_id: string; official_real_name: string }>();
  return rows.results.map((row) => ({ source: row.source, localUserId: row.member_user_id, userId: row.official_student_id, userName: row.official_real_name }));
}

async function autoAcceptTeamMembers(env: AppEnv, officialReservationId: string, members: AuthorizedMember[]): Promise<number> {
  let accepted = 0;
  for (const member of members) {
    if (member.source !== "TEAM" || !member.localUserId) continue;
    try {
      await acceptOfficialReservation(env, await getAccessToken(env, member.localUserId), officialReservationId);
      accepted += 1;
    } catch {
      // The official invitation remains pending and is picked up by later history synchronization.
    }
  }
  return accepted;
}

function redactedResponse(response: unknown): string {
  return JSON.stringify({
    received: response !== null,
    responseType: Array.isArray(response) ? "array" : typeof response,
  });
}

async function submitReadyReservationTasks(env: AppEnv, now: number): Promise<void> {
  if (!flag(env, "ENABLE_SINGLE_RESERVATION_SUBMISSION")) return;
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
      const profile = await getOfficialReservationProfile(env, task.owner_user_id, token);
      const members = await authorizedMembers(env, task.id);
      if (members.length && !flag(env, "ENABLE_MULTIMEMBER_RESERVATION_SUBMISSION")) {
        throw new HttpError(503, "MULTIMEMBER_SUBMISSION_DISABLED", "多人自动预约尚未开放");
      }
      const candidates = await env.DB.prepare(
        "SELECT room_id, room_name_snapshot FROM reservation_task_candidate_rooms WHERE task_id = ? ORDER BY priority",
      ).bind(task.id).all<Candidate>();
      let submitted: { room: Room; response: unknown } | null = null;

      for (const candidate of candidates.results) {
        const room = await fetchOfficialRoomDetail(env, token, candidate.room_id, task.target_date);
        try {
          const duration = assertReservation(room, {
            date: task.target_date,
            startTime: task.start_time,
            endTime: task.end_time,
            memberCount: members.length,
          }, true);
          await localReservationLimits(env, task.owner_user_id, task.target_date, duration);
          if (!await verifyOfficialRoomPolicy(env, token, profile.studentId, room.id, members.map((member) => member.userId))) continue;
          await judgeOfficialReservationUsers(env, token, profile.studentId, members.map((member) => member.userId), task.target_date, task.start_time);
          submitted = {
            room,
            response: await submitOfficialReservation(env, token, {
              ownerStudentId: profile.studentId,
              mobile: profile.mobile,
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
      let officialRecords = await fetchOfficialReservationHistory(env, token, profile.studentId);
      let official = officialRecords.find((record) => {
        const start = shanghaiParts(record.startTime);
        const end = shanghaiParts(record.endTime);
        return record.roomId === submitted!.room.id && start.date === task.target_date && start.time === task.start_time && end.time === task.end_time;
      });
      if (!official) throw new HttpError(502, "RESERVATION_SYNC_FAILED", "官方已接收预约，但订单回读失败");
      if (await autoAcceptTeamMembers(env, String(official.id), members)) {
        officialRecords = await fetchOfficialReservationHistory(env, token, profile.studentId);
        official = officialRecords.find((record) => record.id === official!.id) ?? official;
      }
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO reservations
            (id, task_id, owner_user_id, room_id, room_name_snapshot, date, start_time, end_time,
             member_snapshot_json, submission_type, status, official_response_json_redacted, official_reservation_id,
             official_status, synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTO', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(reservationId, task.id, task.owner_user_id, submitted.room.id, submitted.room.name, task.target_date, task.start_time, task.end_time,
          JSON.stringify(members), localReservationStatus(official.reservationStatus), redactedResponse(submitted.response), String(official.id), official.reservationStatus, createdAt, createdAt, createdAt),
        env.DB.prepare("UPDATE reservation_tasks SET status = 'SUCCESS', official_reservation_id = ?, updated_at = ? WHERE id = ? AND status = 'SUBMITTING'").bind(String(official.id), createdAt, task.id),
      ]);
      await ensureReservationTasks(env, reservationId, official);
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

export async function syncPendingOfficialReservations(env: AppEnv): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT u.id, u.student_id, u.real_name
       FROM reservations r
       JOIN users u ON u.id = r.owner_user_id
      WHERE r.official_reservation_id IS NOT NULL
        AND r.status IN ('WAITING_MEMBER_CONFIRMATION', 'SCHEDULED', 'SIGNED_IN')
      LIMIT 50`,
  ).all<{ id: string; student_id: string | null; real_name: string | null }>();

  for (const user of rows.results) {
    try {
      await syncOfficialReservationHistory(env, user);
    } catch {
      console.error(JSON.stringify({ level: "error", event: "official_reservation_sync_failed", userId: user.id }));
    }
  }
}

type DueSignTask = {
  id: string;
  reservation_id: string;
  official_reservation_id: string;
  status: string;
  owner_user_id: string;
  member_snapshot_json: string;
};

function localSignCandidateUserIds(ownerUserId: string, snapshotJson: string): string[] {
  let members: MemberSnapshot[] = [];
  try {
    const parsed = JSON.parse(snapshotJson) as unknown;
    if (Array.isArray(parsed)) members = parsed.filter((item): item is MemberSnapshot => Boolean(item) && typeof item === "object" && typeof (item as MemberSnapshot).localUserId === "string");
  } catch {
    members = [];
  }
  return [
    ownerUserId,
    ...members.map((member) => member.localUserId).filter((id): id is string => Boolean(id) && id !== ownerUserId),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

async function markSignSuccess(env: AppEnv, taskId: string, reservationId: string, officialStatus = 31): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE sign_tasks SET status = 'SUCCESS', executed_at = ?, official_response_redacted = ? WHERE id = ?")
      .bind(Date.now(), JSON.stringify({ signed: true }), taskId),
    env.DB.prepare("UPDATE reservations SET status = ?, official_status = ?, synced_at = ?, updated_at = ? WHERE id = ?")
      .bind(localReservationStatus(officialStatus), officialStatus, Date.now(), Date.now(), reservationId),
  ]);
}

export async function submitDueSignTasks(env: AppEnv, now: number): Promise<void> {
  if (!flag(env, "ENABLE_AUTO_SIGN_SUBMISSION")) return;
  const rows = await env.DB.prepare(
    `SELECT s.id, s.reservation_id, s.status, r.official_reservation_id, r.owner_user_id, r.member_snapshot_json
       FROM sign_tasks s JOIN reservations r ON r.id = s.reservation_id
      WHERE s.scheduled_at <= ? AND s.status IN ('PENDING', 'SUBMITTING') LIMIT 20`,
  ).bind(now).all<DueSignTask>();

  for (const task of rows.results) {
    try {
      if (!task.official_reservation_id) {
        await env.DB.prepare("UPDATE sign_tasks SET status = 'DISABLED' WHERE id = ?").bind(task.id).run();
        continue;
      }

      let { record } = await findOfficialRecord(env, task.owner_user_id, task.official_reservation_id);
      if (record?.reservationStatus === 31) {
        await markSignSuccess(env, task.id, task.reservation_id, record.reservationStatus);
        continue;
      }
      if (record?.reservationStatus === 51) {
        await markSignSuccess(env, task.id, task.reservation_id, record.reservationStatus);
        continue;
      }
      if (!record || record.reservationStatus !== 21) {
        await env.DB.prepare("UPDATE sign_tasks SET status = 'DISABLED', official_response_redacted = ? WHERE id = ?")
          .bind(JSON.stringify({ reason: "record_not_signable", officialStatus: record?.reservationStatus ?? null }), task.id)
          .run();
        continue;
      }
      if (record.maxSignTime && now > record.maxSignTime) {
        await env.DB.prepare("UPDATE sign_tasks SET status = 'FAILED', official_response_redacted = ? WHERE id = ?")
          .bind(JSON.stringify({ reason: "sign_window_expired" }), task.id)
          .run();
        continue;
      }
      if (record.minSignTime && now < record.minSignTime) continue;

      const claimed = await env.DB.prepare(
        "UPDATE sign_tasks SET status = 'SUBMITTING', attempt_count = attempt_count + 1 WHERE id = ? AND status IN ('PENDING', 'SUBMITTING')",
      ).bind(task.id).run();
      if (claimed.meta.changes !== 1) continue;

      const device = resolveSignDevice(env, record.roomId);
      let lastErrorCode = "OFFICIAL_SIGN_REJECTED";
      let signed = false;
      for (const userId of localSignCandidateUserIds(task.owner_user_id, task.member_snapshot_json)) {
        try {
          const token = await getAccessToken(env, userId);
          const key = await createOfficialQrSignCheckCode(env, token, device.roomId, device.systemMac);
          await submitOfficialSign(env, token, device.roomId, device.systemMac, key);
          signed = true;
          break;
        } catch (error) {
          lastErrorCode = error instanceof HttpError ? error.code : "OFFICIAL_SIGN_REJECTED";
        }
      }

      if (signed) {
        ({ record } = await findOfficialRecord(env, task.owner_user_id, task.official_reservation_id));
        await markSignSuccess(env, task.id, task.reservation_id, record?.reservationStatus === 31 ? 31 : 31);
        continue;
      }

      await env.DB.prepare("UPDATE sign_tasks SET status = ?, official_response_redacted = ? WHERE id = ?")
        .bind(record.maxSignTime && Date.now() > record.maxSignTime ? "FAILED" : "PENDING", JSON.stringify({ reason: lastErrorCode }), task.id)
        .run();
    } catch (error) {
      const failedPermanently = error instanceof HttpError && error.code === "SIGN_DEVICE_NOT_CONFIGURED_FOR_ROOM";
      await env.DB.prepare("UPDATE sign_tasks SET status = ?, official_response_redacted = ? WHERE id = ?")
        .bind(failedPermanently ? "FAILED" : "PENDING", JSON.stringify({ reason: error instanceof HttpError ? error.code : "AUTOMATIC_SIGN_FAILED" }), task.id)
        .run();
      console.error(JSON.stringify({ level: "error", event: "automatic_sign_failed", taskId: task.id, code: error instanceof HttpError ? error.code : "AUTOMATIC_SIGN_FAILED" }));
    }
  }
}

export async function submitDueSignoutTasks(env: AppEnv, now: number): Promise<void> {
  if (!flag(env, "ENABLE_SIGNOUT_SUBMISSION")) return;
  const rows = await env.DB.prepare(
    `SELECT s.id, s.reservation_id, s.official_reservation_id, s.status, r.owner_user_id
       FROM signout_tasks s JOIN reservations r ON r.id = s.reservation_id
      WHERE s.scheduled_at <= ? AND s.status IN ('PENDING', 'SUBMITTING') LIMIT 20`,
  ).bind(now).all<{ id: string; reservation_id: string; official_reservation_id: string; status: string; owner_user_id: string }>();

  for (const task of rows.results) {
    try {
      let { token, studentId, record } = await findOfficialRecord(env, task.owner_user_id, task.official_reservation_id);
      if (record?.reservationStatus === 51) {
        await markSignoutSuccess(env, task.id, task.reservation_id, record.reservationStatus);
        continue;
      }
      if (!record || record.reservationStatus !== 31) {
        await env.DB.prepare("UPDATE signout_tasks SET status = 'DISABLED', official_response_redacted = ? WHERE id = ?")
          .bind(JSON.stringify({ reason: "record_not_signoutable", officialStatus: record?.reservationStatus ?? null }), task.id)
          .run();
        continue;
      }
      const claimed = await env.DB.prepare(
        "UPDATE signout_tasks SET status = 'SUBMITTING', attempt_count = attempt_count + 1 WHERE id = ? AND status IN ('PENDING', 'SUBMITTING')",
      ).bind(task.id).run();
      if (claimed.meta.changes !== 1) continue;
      await signOutOfficialReservation(env, token, studentId, String(record.roomId));
      ({ record } = await findOfficialRecord(env, task.owner_user_id, task.official_reservation_id));
      if (record?.reservationStatus === 51) {
        await markSignoutSuccess(env, task.id, task.reservation_id, record.reservationStatus);
      } else {
        await env.DB.prepare("UPDATE signout_tasks SET status = 'PENDING', official_response_redacted = ? WHERE id = ?")
          .bind(JSON.stringify({ reason: "signout_sync_pending", officialStatus: record?.reservationStatus ?? null }), task.id)
          .run();
      }
    } catch (error) {
      await env.DB.prepare("UPDATE signout_tasks SET status = 'PENDING', official_response_redacted = ? WHERE id = ?")
        .bind(JSON.stringify({ reason: error instanceof HttpError ? error.code : "AUTOMATIC_SIGNOUT_FAILED" }), task.id)
        .run();
      console.error(JSON.stringify({ level: "error", event: "automatic_signout_failed", taskId: task.id, code: error instanceof HttpError ? error.code : "AUTOMATIC_SIGNOUT_FAILED" }));
    }
  }
}

async function markSignoutSuccess(env: AppEnv, taskId: string, reservationId: string, officialStatus: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE signout_tasks SET status = 'SUCCESS', executed_at = ?, official_response_redacted = ? WHERE id = ?")
      .bind(Date.now(), JSON.stringify({ signedOut: true }), taskId),
    env.DB.prepare("UPDATE reservations SET status = 'SIGNED_OUT', official_status = ?, synced_at = ?, updated_at = ? WHERE id = ?")
      .bind(officialStatus, Date.now(), Date.now(), reservationId),
  ]);
}
