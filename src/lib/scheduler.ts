import type { AppEnv } from "../config";
import { flag } from "../config";
import { audit } from "./audit";
import { getAccessToken, getOfficialReservationProfile, recoverExpiredOfficialLogin, refreshCredential } from "./credentials";
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
  type OfficialReservationRecord,
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
import { assertPrimaryReservationScore } from "./reservation-participants";
import { canonicalReservationSource, claimReservationQuota, moveReservationQuota, releaseReservationQuota } from "./user-metrics";

type SchedulerLimitName =
  | "SCHEDULER_REFRESH_LIMIT"
  | "SCHEDULER_PREPARE_LIMIT"
  | "SCHEDULER_RESERVATION_SUBMIT_LIMIT"
  | "SCHEDULER_SYNC_LIMIT"
  | "SCHEDULER_SIGN_LIMIT"
  | "SCHEDULER_SIGNOUT_LIMIT"
  | "SCHEDULER_MAIL_LIMIT";

class SchedulerBudget {
  private readonly startedAt = Date.now();

  constructor(private readonly maxRuntimeMs: number) {}

  hasTime(reserveMs = 1500): boolean {
    return Date.now() - this.startedAt < this.maxRuntimeMs - reserveMs;
  }

  async run(name: string, operation: () => Promise<void>, reserveMs = 1500): Promise<void> {
    if (!this.hasTime(reserveMs)) {
      console.log(JSON.stringify({ level: "info", event: "scheduler_phase_skipped", phase: name, reason: "budget_exhausted" }));
      return;
    }
    try {
      await operation();
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "scheduler_phase_failed", phase: name, code: error instanceof HttpError ? error.code : "SCHEDULER_PHASE_FAILED" }));
    }
  }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function schedulerLimit(env: AppEnv, name: SchedulerLimitName, fallback: number, max: number): number {
  return boundedInteger(env[name], fallback, 1, max);
}

export async function runScheduler(env: AppEnv): Promise<void> {
  const now = Date.now();
  const budget = new SchedulerBudget(boundedInteger(env.SCHEDULER_MAX_RUNTIME_MS, 18_000, 5_000, 28_000));
  await budget.run("refresh-official-snapshots", () => refreshOfficialSnapshots(env, now));
  await budget.run("expire-invitations", async () => {
    await Promise.all([expireInvitations(env, now), expireTeamInvitations(env, now)]);
  });
  await budget.run("accept-reservation-members", () => submitPendingMemberAcceptanceTasks(env, now, schedulerLimit(env, "SCHEDULER_SYNC_LIMIT", 5, 20)), 2500);
  await budget.run("prepare-reservation-tasks", () => prepareReservationTasks(env, now, schedulerLimit(env, "SCHEDULER_PREPARE_LIMIT", 5, 20)));
  await budget.run("submit-reservation-tasks", () => submitReadyReservationTasks(env, now, schedulerLimit(env, "SCHEDULER_RESERVATION_SUBMIT_LIMIT", 2, 10)), 4000);
  await budget.run("sync-official-reservations", () => syncPendingOfficialReservations(env, schedulerLimit(env, "SCHEDULER_SYNC_LIMIT", 3, 20)), 4000);
  await budget.run("backfill-sign-workflows", () => backfillSignWorkflows(env, schedulerLimit(env, "SCHEDULER_SIGN_LIMIT", 5, 20)), 3500);
  await budget.run("submit-sign-workflows", () => submitDueSignWorkflows(env, now, schedulerLimit(env, "SCHEDULER_SIGN_LIMIT", 5, 20)), 3000);
  await budget.run("refresh-credentials", () => refreshDueCredentials(env, now, schedulerLimit(env, "SCHEDULER_REFRESH_LIMIT", 3, 20)), 4000);
  await budget.run("deliver-mail", () => deliverDueMail(env, now, schedulerLimit(env, "SCHEDULER_MAIL_LIMIT", 2, 10)), 4000);
  await budget.run("cleanup-sessions", () => cleanupSessions(env, now));
}

function shanghaiDate(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

async function refreshOfficialSnapshots(env: AppEnv, now: number): Promise<void> {
  if (!env.OFFICIAL_GATEWAY) return;
  const roomKey = `global:rooms:${shanghaiDate(now)}`;
  const roomSnapshot = await env.OFFICIAL_GATEWAY.readSnapshot(roomKey);
  if (!roomSnapshot || roomSnapshot.freshUntil <= now) {
    const user = await env.DB.prepare(
      `SELECT u.id
         FROM users u JOIN official_credentials c ON c.user_id = u.id
        WHERE u.status = 'ACTIVE' AND c.credential_status = 'ACTIVE'
        ORDER BY COALESCE(c.last_refresh_success_at, 0) DESC LIMIT 1`,
    ).first<{ id: string }>();
    if (user) {
      const job = await env.OFFICIAL_GATEWAY.enqueue({
        kind: "ROOMS_REFRESH",
        lane: "READ",
        ownerUserId: user.id,
        dedupeKey: `refresh:${roomKey}`,
        payload: { snapshotKey: roomKey },
        priority: 80,
      });
      await env.OFFICIAL_GATEWAY.linkSnapshotRefresh(roomKey, job.id);
    }
  }

  const staleScores = await env.DB.prepare(
    `SELECT u.id
       FROM users u JOIN official_credentials c ON c.user_id = u.id
       LEFT JOIN official_gateway_snapshots s ON s.cache_key = 'user:' || u.id || ':score'
      WHERE u.status = 'ACTIVE' AND u.student_id IS NOT NULL AND c.credential_status = 'ACTIVE'
        AND (s.cache_key IS NULL OR s.fresh_until <= ?)
      ORDER BY COALESCE(s.refreshed_at, 0) ASC LIMIT 3`,
  ).bind(now).all<{ id: string }>();
  for (const user of staleScores.results) {
    const key = `user:${user.id}:score`;
    const job = await env.OFFICIAL_GATEWAY.enqueue({
      kind: "USER_SCORE_REFRESH",
      lane: "READ",
      ownerUserId: user.id,
      dedupeKey: `refresh:${key}`,
      payload: {},
      priority: 90,
    });
    await env.OFFICIAL_GATEWAY.linkSnapshotRefresh(key, job.id);
  }

  const staleReservations = await env.DB.prepare(
    `SELECT u.id
       FROM users u JOIN official_credentials c ON c.user_id = u.id
       LEFT JOIN official_gateway_snapshots s ON s.cache_key = 'user:' || u.id || ':reservations'
      WHERE u.status = 'ACTIVE' AND u.student_id IS NOT NULL AND c.credential_status = 'ACTIVE'
        AND (s.cache_key IS NULL OR s.fresh_until <= ?)
      ORDER BY COALESCE(s.refreshed_at, 0) ASC LIMIT 3`,
  ).bind(now).all<{ id: string }>();
  for (const user of staleReservations.results) {
    const key = `user:${user.id}:reservations`;
    const job = await env.OFFICIAL_GATEWAY.enqueue({
      kind: "RESERVATIONS_REFRESH",
      lane: "READ",
      ownerUserId: user.id,
      dedupeKey: `refresh:${key}`,
      payload: {},
      priority: 95,
    });
    await env.OFFICIAL_GATEWAY.linkSnapshotRefresh(key, job.id);
  }

  await env.DB.prepare(
    `DELETE FROM reservation_quota_claims
      WHERE source_type = 'TASK' AND NOT EXISTS (
        SELECT 1 FROM reservation_tasks task
         WHERE task.id = reservation_quota_claims.source_id
           AND task.status IN ('DRAFT', 'WAITING_WINDOW', 'WAITING_MEMBERS', 'READY', 'SUBMITTING')
      )`,
  ).run();

  const unclaimedTasks = await env.DB.prepare(
    `SELECT task.id, task.owner_user_id, task.target_date
       FROM reservation_tasks task
      WHERE task.status IN ('DRAFT', 'WAITING_WINDOW', 'WAITING_MEMBERS', 'READY', 'SUBMITTING')
        AND NOT EXISTS (
          SELECT 1 FROM reservation_quota_claims claim
           WHERE claim.source_type = 'TASK' AND claim.source_id = task.id
        )
      LIMIT 20`,
  ).all<{ id: string; owner_user_id: string; target_date: string }>();
  for (const task of unclaimedTasks.results) {
    const members = await env.DB.prepare(
      "SELECT member_user_id FROM reservation_task_members WHERE task_id = ? AND member_user_id IS NOT NULL",
    ).bind(task.id).all<{ member_user_id: string }>();
    try {
      await claimReservationQuota(env, [task.owner_user_id, ...members.results.map((member) => member.member_user_id)], task.target_date, "TASK", task.id);
    } catch {
      // Existing tasks are left intact; the normal submit-time checks remain authoritative.
    }
  }
}

async function expireTeamInvitations(env: AppEnv, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE team_invitations SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ?",
  ).bind(now).run();
}

async function refreshDueCredentials(env: AppEnv, now: number, limit = 3): Promise<void> {
  const cutoff = now - 90 * 60 * 1000;
  const rows = await env.DB.prepare(
    `SELECT user_id, credential_status FROM official_credentials
      WHERE (credential_status IN ('ACTIVE', 'REFRESH_FAILED') AND COALESCE(last_refresh_success_at, 0) < ?)
         OR credential_status = 'REAUTH_REQUIRED'
      LIMIT ${limit}`,
  ).bind(cutoff).all<{ user_id: string; credential_status: string }>();
  for (const row of rows.results) {
    try {
      if (row.credential_status === "REAUTH_REQUIRED") await env.CAS_AUTOMATION?.startRecovery(row.user_id);
      else await refreshCredential(env, row.user_id, "SCHEDULED");
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "credential_refresh_failed", userId: row.user_id, code: error instanceof HttpError ? error.code : "CREDENTIAL_REFRESH_FAILED" }));
    }
  }
}

async function expireInvitations(env: AppEnv, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE reservation_invitations SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ?",
  ).bind(now).run();
}

async function cleanupSessions(env: AppEnv, now: number): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now).run();
  await env.DB.prepare("DELETE FROM login_attempts WHERE created_at <= ?").bind(now - 24 * 60 * 60 * 1000).run();
  await env.DB.prepare(
    "DELETE FROM official_gateway_jobs WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND finished_at <= ?",
  ).bind(now - 7 * 24 * 60 * 60 * 1000).run();
}

async function prepareReservationTasks(env: AppEnv, now: number, limit = 5): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, owner_user_id, target_date FROM reservation_tasks
      WHERE status IN ('WAITING_WINDOW', 'WAITING_MEMBERS') LIMIT ${limit}`,
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
  requested_by_user_id: string;
  target_date: string;
  start_time: string;
  end_time: string;
};

type NotificationUser = {
  id: string;
  email: string;
  real_name: string | null;
};

async function queueUserNotifications(
  env: AppEnv,
  users: NotificationUser[],
  eventKey: string,
  template: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const unique = new Map(users.map((user) => [user.id, user]));
  for (const user of unique.values()) {
    await queueMail(env, user.email, template, payload, { dedupeKey: `${eventKey}:${user.id}` });
  }
}

async function taskNotificationUsers(env: AppEnv, task: ReadyTask): Promise<NotificationUser[]> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT u.id, u.email, u.real_name
       FROM users u
      WHERE u.status = 'ACTIVE'
        AND (u.id IN (?, ?) OR EXISTS (
          SELECT 1 FROM reservation_task_members member
           WHERE member.task_id = ? AND member.member_user_id = u.id
        ))`,
  ).bind(task.owner_user_id, task.requested_by_user_id, task.id).all<NotificationUser>();
  return rows.results;
}

async function taskParticipantNames(env: AppEnv, task: ReadyTask): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT u.real_name AS name, 0 AS participant_order
       FROM users u WHERE u.id = ?
     UNION ALL
     SELECT COALESCE(u.real_name, member.official_real_name) AS name, member.participant_order
       FROM reservation_task_members member
       LEFT JOIN users u ON u.id = member.member_user_id
      WHERE member.task_id = ?
      ORDER BY participant_order`,
  ).bind(task.owner_user_id, task.id).all<{ name: string | null }>();
  return rows.results.map((row) => row.name).filter((name): name is string => Boolean(name));
}

async function taskCandidateRoomNames(env: AppEnv, taskId: string): Promise<string> {
  const rows = await env.DB.prepare(
    "SELECT room_name_snapshot FROM reservation_task_candidate_rooms WHERE task_id = ? ORDER BY priority",
  ).bind(taskId).all<{ room_name_snapshot: string }>();
  return rows.results.map((row) => row.room_name_snapshot).filter(Boolean).join(" / ") || "候选研讨间";
}

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
    `SELECT source, member_user_id, official_student_id, official_real_name
       FROM reservation_task_members WHERE task_id = ? ORDER BY participant_order, created_at`,
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

type MemberAcceptanceTask = {
  id: string;
  reservation_id: string | null;
  owner_user_id: string;
  member_user_id: string;
  official_reservation_id: string;
  room_id: number;
  date: string;
  start_time: string;
  end_time: string;
  attempt_count: number;
};

function reservationAccepted(record: OfficialReservationRecord): boolean {
  return [21, 31, 51, 53].includes(record.reservationStatus);
}

function matchingOfficialReservation(
  records: OfficialReservationRecord[],
  task: Pick<MemberAcceptanceTask, "official_reservation_id" | "room_id" | "date" | "start_time" | "end_time">,
): OfficialReservationRecord | null {
  return records.find((record) => String(record.id) === task.official_reservation_id)
    ?? records.find((record) => {
      const start = shanghaiParts(record.startTime);
      const end = shanghaiParts(record.endTime);
      return record.roomId === task.room_id && start.date === task.date && start.time === task.start_time && end.time === task.end_time;
    })
    ?? null;
}

function memberAcceptanceRetryDelayMs(attemptCount: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, Math.min(attemptCount, 6)));
}

async function markMemberAcceptanceSuccess(env: AppEnv, task: MemberAcceptanceTask, record: OfficialReservationRecord): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE reservation_member_acceptance_tasks
          SET status = 'SUCCESS', last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE id = ?`,
    ).bind(now, task.id),
    env.DB.prepare(
      `UPDATE reservations
          SET status = ?, official_status = ?, synced_at = ?, updated_at = ?
        WHERE owner_user_id = ? AND official_reservation_id = ?`,
    ).bind(localReservationStatus(record.reservationStatus), record.reservationStatus, now, now, task.owner_user_id, String(record.id)),
  ]);
  await syncOfficialReservationHistory(env, { id: task.owner_user_id, student_id: null, real_name: null });
}

async function rescheduleMemberAcceptance(env: AppEnv, task: MemberAcceptanceTask, error: unknown): Promise<void> {
  const code = error instanceof HttpError ? error.code : "MEMBER_ACCEPT_FAILED";
  const message = error instanceof Error ? error.message : "成员同意预约失败";
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE reservation_member_acceptance_tasks
        SET status = 'PENDING', next_attempt_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(now + memberAcceptanceRetryDelayMs(task.attempt_count), code, message, now, task.id).run();
  console.error(JSON.stringify({ level: "warn", event: "reservation_member_acceptance_retry", taskId: task.id, code }));
}

async function submitPendingMemberAcceptanceTasks(env: AppEnv, now: number, limit = 5): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, reservation_id, owner_user_id, member_user_id, official_reservation_id, room_id, date, start_time, end_time, attempt_count
       FROM reservation_member_acceptance_tasks
      WHERE status IN ('PENDING', 'RUNNING') AND next_attempt_at <= ?
      ORDER BY next_attempt_at, updated_at LIMIT ${limit}`,
  ).bind(now).all<MemberAcceptanceTask>();

  for (const task of rows.results) {
    const claimed = await env.DB.prepare(
      `UPDATE reservation_member_acceptance_tasks
          SET status = 'RUNNING', attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'RUNNING')`,
    ).bind(Date.now(), task.id).run();
    if (claimed.meta.changes !== 1) continue;
    const currentTask = { ...task, attempt_count: task.attempt_count + 1 };
    try {
      const token = await getAccessToken(env, task.member_user_id);
      const profile = await getOfficialReservationProfile(env, task.member_user_id, token);
      let record = matchingOfficialReservation(await fetchOfficialReservationHistory(env, token, profile.studentId), task);
      if (!record) throw new HttpError(502, "MEMBER_RESERVATION_NOT_FOUND", "成员端暂未同步到官方预约邀请");
      if ([61, 63].includes(record.reservationStatus)) {
        await env.DB.prepare(
          `UPDATE reservation_member_acceptance_tasks
              SET status = 'DISABLED', last_error_code = 'RESERVATION_CANCELLED', updated_at = ?
            WHERE id = ?`,
        ).bind(Date.now(), task.id).run();
        continue;
      }
      if (!reservationAccepted(record)) {
        if (record.reservationStatus !== 12) throw new HttpError(409, "MEMBER_RESERVATION_NOT_ACCEPTABLE", "成员端预约状态无法自动同意");
        await acceptOfficialReservation(env, token, String(record.id));
        record = matchingOfficialReservation(await fetchOfficialReservationHistory(env, token, profile.studentId), {
          ...task,
          official_reservation_id: String(record.id),
        });
      }
      if (record && reservationAccepted(record)) {
        await markMemberAcceptanceSuccess(env, task, record);
      } else {
        throw new HttpError(502, "MEMBER_ACCEPTANCE_NOT_CONFIRMED", "成员同意请求已提交但尚未确认");
      }
    } catch (error) {
      await recoverExpiredOfficialLogin(env, task.member_user_id, error);
      await rescheduleMemberAcceptance(env, currentTask, error);
    }
  }
}

function redactedResponse(response: unknown): string {
  return JSON.stringify({
    received: response !== null,
    responseType: Array.isArray(response) ? "array" : typeof response,
  });
}

async function submitReadyReservationTasks(env: AppEnv, now: number, limit = 2): Promise<void> {
  if (!flag(env, "ENABLE_SINGLE_RESERVATION_SUBMISSION")) return;
  const tasks = await env.DB.prepare(
    `SELECT id, owner_user_id, COALESCE(requested_by_user_id, owner_user_id) AS requested_by_user_id,
            target_date, start_time, end_time
       FROM reservation_tasks WHERE status = 'READY' LIMIT ${limit}`,
  ).all<ReadyTask>();

  for (const task of tasks.results) {
    const claimed = await env.DB.prepare(
      "UPDATE reservation_tasks SET status = 'SUBMITTING', attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'READY'",
    ).bind(now, now, task.id).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      const token = await getAccessToken(env, task.owner_user_id);
      const profile = await getOfficialReservationProfile(env, task.owner_user_id, token);
      const primary = await env.DB.prepare("SELECT id, email, student_id, real_name FROM users WHERE id = ?")
        .bind(task.owner_user_id).first<{ id: string; email: string; student_id: string; real_name: string }>();
      if (!primary?.student_id) throw new HttpError(409, "SETUP_REQUIRED", "主预约人尚未完成官方绑定");
      await assertPrimaryReservationScore(env, {
        id: primary.id,
        email: primary.email,
        studentId: primary.student_id,
        realName: primary.real_name,
        isCurrentUser: primary.id === task.requested_by_user_id,
        teamName: null,
      });
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
            (id, task_id, owner_user_id, requested_by_user_id, room_id, room_name_snapshot, date, start_time, end_time,
             member_snapshot_json, submission_type, status, official_response_json_redacted, official_reservation_id,
             official_status, synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTO', ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(reservationId, task.id, task.owner_user_id, task.requested_by_user_id, submitted.room.id, submitted.room.name, task.target_date, task.start_time, task.end_time,
          JSON.stringify(members), localReservationStatus(official.reservationStatus), redactedResponse(submitted.response), String(official.id), official.reservationStatus, createdAt, createdAt, createdAt),
        env.DB.prepare("UPDATE reservation_tasks SET status = 'SUCCESS', official_reservation_id = ?, updated_at = ? WHERE id = ? AND status = 'SUBMITTING'").bind(String(official.id), createdAt, task.id),
      ]);
      const quotaSource = canonicalReservationSource({
        roomId: submitted.room.id,
        date: task.target_date,
        startTime: task.start_time,
        endTime: task.end_time,
        studentIds: [profile.studentId, ...members.map((member) => member.userId)],
      });
      try {
        await moveReservationQuota(env, "TASK", task.id, "RESERVATION", quotaSource);
      } catch {
        await releaseReservationQuota(env, "TASK", task.id);
      }
      await ensureReservationTasks(env, reservationId, official);
      await audit(env.DB, { actorUserId: task.owner_user_id, actorType: "SYSTEM", action: "AUTO_RESERVATION_SUBMITTED", targetType: "RESERVATION", targetId: reservationId, result: "SUBMITTED_UNVERIFIED" });
      await queueUserNotifications(env, await taskNotificationUsers(env, task), `auto-reservation:${task.id}:success`, "AUTO_RESERVATION_SUCCESS", {
        date: task.target_date,
        startTime: task.start_time,
        endTime: task.end_time,
        roomName: submitted.room.name,
        participants: [profile.realName, ...members.map((member) => member.userName)],
      });
    } catch (error) {
      const message = error instanceof HttpError ? error.message : "自动预约提交失败";
      const recovering = await recoverExpiredOfficialLogin(env, task.owner_user_id, error);
      if (recovering || (error instanceof HttpError && error.code === "CREDENTIAL_RECOVERY_IN_PROGRESS")) {
        await env.DB.prepare(
          "UPDATE reservation_tasks SET status = 'READY', failure_code = NULL, failure_message = NULL, updated_at = ? WHERE id = ? AND status = 'SUBMITTING'",
        ).bind(Date.now(), task.id).run();
        continue;
      }
      await env.DB.prepare(
        "UPDATE reservation_tasks SET status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ? AND status = 'SUBMITTING'",
      ).bind(error instanceof HttpError ? error.code : "AUTO_SUBMISSION_FAILED", message, Date.now(), task.id).run();
      await releaseReservationQuota(env, "TASK", task.id);
      await queueUserNotifications(env, await taskNotificationUsers(env, task), `auto-reservation:${task.id}:failed`, "AUTO_RESERVATION_FAILED", {
        date: task.target_date,
        startTime: task.start_time,
        endTime: task.end_time,
        roomName: await taskCandidateRoomNames(env, task.id),
        participants: await taskParticipantNames(env, task),
        reason: message,
      });
      await audit(env.DB, { actorUserId: task.owner_user_id, actorType: "SYSTEM", action: "AUTO_RESERVATION_SUBMITTED", targetType: "RESERVATION_TASK", targetId: task.id, result: "FAILED", metadata: { code: error instanceof HttpError ? error.code : "AUTO_SUBMISSION_FAILED" } });
    }
  }
}

export async function syncPendingOfficialReservations(env: AppEnv, limit = 3): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT u.id, u.student_id, u.real_name
       FROM reservations r
       JOIN users u ON u.id = r.owner_user_id
      WHERE r.official_reservation_id IS NOT NULL
        AND r.status IN ('WAITING_MEMBER_CONFIRMATION', 'SCHEDULED', 'SIGNED_IN')
      LIMIT ${limit}`,
  ).all<{ id: string; student_id: string | null; real_name: string | null }>();

  for (const user of rows.results) {
    try {
      await syncOfficialReservationHistory(env, user);
    } catch {
      console.error(JSON.stringify({ level: "error", event: "official_reservation_sync_failed", userId: user.id }));
    }
  }
}

async function backfillSignWorkflows(env: AppEnv, limit = 20): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.owner_user_id, r.official_reservation_id
       FROM reservations r
       LEFT JOIN sign_workflows w ON w.reservation_id = r.id
      WHERE w.id IS NULL AND r.official_reservation_id IS NOT NULL
        AND r.status IN ('WAITING_MEMBER_CONFIRMATION', 'SCHEDULED', 'SIGNED_IN')
      LIMIT ${limit}`,
  ).all<{ id: string; owner_user_id: string; official_reservation_id: string }>();
  for (const row of rows.results) {
    try {
      const { record } = await findOfficialRecord(env, row.owner_user_id, row.official_reservation_id);
      if (record) await ensureReservationTasks(env, row.id, record);
    } catch {
      // Later scheduler passes retry the backfill after credentials or official access recover.
    }
  }
}

type SignWorkflowRow = {
  id: string;
  requested_by_user_id: string;
  anchor_user_id: string;
  official_reservation_id: string;
  room_id: number;
  room_name_snapshot: string;
  date: string;
  start_time: string;
  end_time: string;
  sign_scheduled_at: number;
  signout_scheduled_at: number;
  signout_advance_minutes: number;
  signout_status: string;
};

type WorkflowParticipantRow = {
  user_id: string;
  participant_order: number;
  sign_status: string;
  real_name?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
};

async function workflowNotificationUsers(env: AppEnv, workflow: SignWorkflowRow, participants: WorkflowParticipantRow[]): Promise<NotificationUser[]> {
  const ids = [...new Set([workflow.requested_by_user_id, workflow.anchor_user_id, ...participants.map((participant) => participant.user_id)])];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT id, email, real_name FROM users WHERE status = 'ACTIVE' AND id IN (${placeholders})`,
  ).bind(...ids).all<NotificationUser>();
  return rows.results;
}

function workflowPayload(workflow: SignWorkflowRow, participants: WorkflowParticipantRow[]): Record<string, unknown> {
  return {
    roomName: workflow.room_name_snapshot,
    date: workflow.date,
    startTime: workflow.start_time,
    endTime: workflow.end_time,
    participants: participants.map((participant) => participant.real_name || participant.user_id),
  };
}

export function workflowNotificationKey(workflow: Pick<SignWorkflowRow, "room_id" | "date" | "start_time" | "end_time">): string {
  return `${workflow.room_id}:${workflow.date}:${workflow.start_time}:${workflow.end_time}`;
}

function workflowRecordMatches(workflow: SignWorkflowRow, record: { roomId: number; startTime: number; endTime: number }): boolean {
  if (record.roomId !== workflow.room_id) return false;
  const start = shanghaiParts(record.startTime);
  const end = shanghaiParts(record.endTime);
  return start.date === workflow.date && start.time === workflow.start_time && end.time === workflow.end_time;
}

function publicWorkflowFailureReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === "DAILY_RESERVATION_LIMIT" || reason.includes("当日已达到") || reason.includes("预约次数")) {
    return "今日无可用预约次数";
  }
  return reason;
}

async function participantOfficialRecord(env: AppEnv, workflow: SignWorkflowRow, userId: string) {
  const token = await getAccessToken(env, userId);
  const profile = await getOfficialReservationProfile(env, userId, token);
  const records = await fetchOfficialReservationHistory(env, token, profile.studentId);
  const record = records.find((candidate) => String(candidate.id) === workflow.official_reservation_id)
    ?? records.find((candidate) => workflowRecordMatches(workflow, candidate))
    ?? null;
  return { token, profile, record };
}

export async function submitDueSignWorkflows(env: AppEnv, now: number, limit = 20): Promise<void> {
  const workflows = await env.DB.prepare(
    `SELECT id, requested_by_user_id, anchor_user_id, official_reservation_id, room_id,
            room_name_snapshot, date, start_time, end_time, sign_scheduled_at,
            signout_scheduled_at, signout_advance_minutes, signout_status
       FROM sign_workflows
      WHERE status = 'ACTIVE' AND (sign_scheduled_at <= ? OR signout_scheduled_at <= ?)
      ORDER BY MIN(sign_scheduled_at, signout_scheduled_at) LIMIT ${limit}`,
  ).bind(now, now).all<SignWorkflowRow>();

  for (const workflow of workflows.results) {
    const autoSignEnabled = flag(env, "ENABLE_AUTO_SIGN_SUBMISSION");
    const participants = await env.DB.prepare(
      `SELECT participant.user_id, participant.participant_order, participant.sign_status,
              participant.last_error_code, participant.last_error_message, user.real_name
         FROM sign_workflow_participants participant
         JOIN users user ON user.id = participant.user_id
        WHERE participant.workflow_id = ? ORDER BY participant.participant_order`,
    ).bind(workflow.id).all<WorkflowParticipantRow>();

    if (autoSignEnabled && now >= workflow.sign_scheduled_at) {
      for (const participant of participants.results) {
        if (participant.sign_status === "SUCCESS" || participant.sign_status === "DISABLED") continue;
        try {
          const current = await participantOfficialRecord(env, workflow, participant.user_id);
          const record = current.record;
          if (!record || [61, 63].includes(record.reservationStatus)) {
            await env.DB.prepare(
              `UPDATE sign_workflow_participants
                  SET sign_status = 'DISABLED', last_error_code = 'RESERVATION_NOT_SIGNABLE', updated_at = ?
                WHERE workflow_id = ? AND user_id = ?`,
            ).bind(Date.now(), workflow.id, participant.user_id).run();
            continue;
          }
          if ([31, 51, 53].includes(record.reservationStatus)) {
            await env.DB.prepare(
              `UPDATE sign_workflow_participants
                  SET sign_status = 'SUCCESS', signed_at = COALESCE(signed_at, ?), updated_at = ?
                WHERE workflow_id = ? AND user_id = ?`,
            ).bind(record.signInTime ?? Date.now(), Date.now(), workflow.id, participant.user_id).run();
            continue;
          }
          if (record.reservationStatus !== 21 || (record.minSignTime && now < record.minSignTime)) continue;
          if (record.maxSignTime && now > record.maxSignTime) {
            await env.DB.prepare(
              `UPDATE sign_workflow_participants
                  SET sign_status = 'FAILED', last_error_code = 'SIGN_WINDOW_EXPIRED', updated_at = ?
                WHERE workflow_id = ? AND user_id = ?`,
            ).bind(Date.now(), workflow.id, participant.user_id).run();
            continue;
          }
          const claimed = await env.DB.prepare(
            `UPDATE sign_workflow_participants
                SET sign_status = 'SUBMITTING', sign_attempt_count = sign_attempt_count + 1, updated_at = ?
              WHERE workflow_id = ? AND user_id = ? AND sign_status IN ('PENDING', 'SUBMITTING', 'FAILED')`,
          ).bind(Date.now(), workflow.id, participant.user_id).run();
          if (claimed.meta.changes !== 1) continue;
          const device = resolveSignDevice(env, record.roomId);
          if (Number(device.roomId) !== workflow.room_id) throw new HttpError(409, "SIGN_ROOM_MISMATCH", "签到预约的真实房间与任务不一致");
          const key = await createOfficialQrSignCheckCode(env, current.token, device.roomId, device.systemMac);
          await submitOfficialSign(env, current.token, device.roomId, device.systemMac, key);
          const confirmed = await participantOfficialRecord(env, workflow, participant.user_id);
          if (confirmed.record && [31, 51, 53].includes(confirmed.record.reservationStatus)) {
            await env.DB.prepare(
              `UPDATE sign_workflow_participants
                  SET sign_status = 'SUCCESS', signed_at = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
                WHERE workflow_id = ? AND user_id = ?`,
            ).bind(confirmed.record.signInTime ?? Date.now(), Date.now(), workflow.id, participant.user_id).run();
          } else {
            await env.DB.prepare(
              `UPDATE sign_workflow_participants SET sign_status = 'PENDING', last_error_code = 'SIGN_SYNC_PENDING', updated_at = ?
                WHERE workflow_id = ? AND user_id = ?`,
            ).bind(Date.now(), workflow.id, participant.user_id).run();
          }
        } catch (error) {
          await recoverExpiredOfficialLogin(env, participant.user_id, error);
          await env.DB.prepare(
            `UPDATE sign_workflow_participants
                SET sign_status = 'PENDING', last_error_code = ?, last_error_message = ?, updated_at = ?
              WHERE workflow_id = ? AND user_id = ?`,
          ).bind(
            error instanceof HttpError ? error.code : "AUTOMATIC_SIGN_FAILED",
            error instanceof Error ? error.message : "自动签到失败",
            Date.now(),
            workflow.id,
            participant.user_id,
          ).run();
        }
      }
    }

    const refreshed = await env.DB.prepare(
      `SELECT participant.user_id, participant.participant_order, participant.sign_status,
              participant.last_error_code, participant.last_error_message, user.real_name
         FROM sign_workflow_participants participant
         JOIN users user ON user.id = participant.user_id
        WHERE participant.workflow_id = ? ORDER BY participant.participant_order`,
    ).bind(workflow.id).all<WorkflowParticipantRow>();
    const allSigned = refreshed.results.length > 0 && refreshed.results.every((participant) => participant.sign_status === "SUCCESS");
    const recipients = await workflowNotificationUsers(env, workflow, refreshed.results);
    const payload = workflowPayload(workflow, refreshed.results);
    const notificationKey = workflowNotificationKey(workflow);
    const endAt = workflow.signout_scheduled_at + workflow.signout_advance_minutes * 60_000;

    if (allSigned) {
      await queueUserNotifications(env, recipients, `auto-sign:${notificationKey}:success`, "AUTO_SIGN_SUCCESS", payload);
    } else {
      if (autoSignEnabled && now >= endAt) {
        const reason = publicWorkflowFailureReason(refreshed.results.find((participant) => participant.last_error_message)?.last_error_message)
          ?? publicWorkflowFailureReason(refreshed.results.find((participant) => participant.last_error_code)?.last_error_code)
          ?? "预约结束前未完成全部成员签到";
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE sign_workflow_participants
                SET sign_status = 'FAILED', last_error_code = COALESCE(last_error_code, 'SIGN_DEADLINE_EXPIRED'), updated_at = ?
              WHERE workflow_id = ? AND sign_status <> 'SUCCESS'`,
          ).bind(now, workflow.id),
          env.DB.prepare(
            `UPDATE sign_workflows
                SET status = 'FAILED', signout_status = 'DISABLED', failure_code = 'SIGN_DEADLINE_EXPIRED',
                    failure_message = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'`,
          ).bind(reason, now, workflow.id),
        ]);
        await queueUserNotifications(env, recipients, `auto-sign:${notificationKey}:failed`, "AUTO_SIGN_FAILED", { ...payload, reason });
      }
      continue;
    }

    if (!flag(env, "ENABLE_SIGNOUT_SUBMISSION") || now < workflow.signout_scheduled_at || workflow.signout_status === "SUCCESS") continue;

    await env.DB.prepare(
      `UPDATE sign_workflows SET signout_status = 'SUBMITTING', signout_attempt_count = signout_attempt_count + 1, updated_at = ?
        WHERE id = ? AND signout_status IN ('PENDING', 'SUBMITTING', 'FAILED')`,
    ).bind(Date.now(), workflow.id).run();
    let signedOutBy: string | null = null;
    let lastErrorCode = "AUTOMATIC_SIGNOUT_FAILED";
    for (const participant of refreshed.results) {
      try {
        const current = await participantOfficialRecord(env, workflow, participant.user_id);
        if (!current.record) continue;
        if ([51, 53].includes(current.record.reservationStatus)) {
          signedOutBy = participant.user_id;
          break;
        }
        if (current.record.reservationStatus !== 31) continue;
        if (current.record.roomId !== workflow.room_id) throw new HttpError(409, "SIGNOUT_ROOM_MISMATCH", "签退预约的真实房间与任务不一致");
        await signOutOfficialReservation(env, current.token, current.profile.studentId, String(current.record.roomId));
        const confirmed = await participantOfficialRecord(env, workflow, participant.user_id);
        if (confirmed.record && [51, 53].includes(confirmed.record.reservationStatus)) {
          signedOutBy = participant.user_id;
          break;
        }
        lastErrorCode = "SIGNOUT_SYNC_PENDING";
      } catch (error) {
        await recoverExpiredOfficialLogin(env, participant.user_id, error);
        lastErrorCode = error instanceof HttpError ? error.code : "AUTOMATIC_SIGNOUT_FAILED";
      }
    }
    if (signedOutBy) {
      await env.DB.prepare(
        `UPDATE sign_workflows
            SET status = 'SUCCESS', signout_status = 'SUCCESS', signout_user_id = ?, signout_executed_at = ?,
                failure_code = NULL, failure_message = NULL, updated_at = ? WHERE id = ?`,
      ).bind(signedOutBy, Date.now(), Date.now(), workflow.id).run();
      await queueUserNotifications(env, recipients, `auto-signout:${notificationKey}:success`, "AUTO_SIGNOUT_SUCCESS", payload);
    } else if (now >= endAt) {
      const reason = lastErrorCode === "SIGNOUT_SYNC_PENDING" ? "签退已提交，但预约结束前未能确认结果" : lastErrorCode;
      await env.DB.prepare(
        `UPDATE sign_workflows
            SET status = 'FAILED', signout_status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = ?
          WHERE id = ? AND status = 'ACTIVE'`,
      ).bind(lastErrorCode, reason, now, workflow.id).run();
      await queueUserNotifications(env, recipients, `auto-signout:${notificationKey}:failed`, "AUTO_SIGNOUT_FAILED", { ...payload, reason });
    } else {
      await env.DB.prepare(
        `UPDATE sign_workflows SET signout_status = 'PENDING', failure_code = ?, updated_at = ? WHERE id = ?`,
      ).bind(lastErrorCode, Date.now(), workflow.id).run();
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

export async function submitDueSignTasks(env: AppEnv, now: number, limit = 20): Promise<void> {
  if (!flag(env, "ENABLE_AUTO_SIGN_SUBMISSION")) return;
  const rows = await env.DB.prepare(
    `SELECT s.id, s.reservation_id, s.status, r.official_reservation_id, r.owner_user_id, r.member_snapshot_json
       FROM sign_tasks s JOIN reservations r ON r.id = s.reservation_id
      WHERE s.scheduled_at <= ? AND s.status IN ('PENDING', 'SUBMITTING') LIMIT ${limit}`,
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
      if (record?.reservationStatus === 51 || record?.reservationStatus === 53) {
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

export async function submitDueSignoutTasks(env: AppEnv, now: number, limit = 20): Promise<void> {
  if (!flag(env, "ENABLE_SIGNOUT_SUBMISSION")) return;
  const rows = await env.DB.prepare(
    `SELECT s.id, s.reservation_id, s.official_reservation_id, s.status, r.owner_user_id
       FROM signout_tasks s JOIN reservations r ON r.id = s.reservation_id
      WHERE s.scheduled_at <= ? AND s.status IN ('PENDING', 'SUBMITTING') LIMIT ${limit}`,
  ).bind(now).all<{ id: string; reservation_id: string; official_reservation_id: string; status: string; owner_user_id: string }>();

  for (const task of rows.results) {
    try {
      let { token, studentId, record } = await findOfficialRecord(env, task.owner_user_id, task.official_reservation_id);
      if (record?.reservationStatus === 51 || record?.reservationStatus === 53) {
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
      if (record?.reservationStatus === 51 || record?.reservationStatus === 53) {
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
