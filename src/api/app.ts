import type { AppEnv } from "../config";
import { flag, integerVar } from "../config";
import { requireAdmin, requireUser, revokeSession, type User } from "../lib/auth";
import { audit } from "../lib/audit";
import { bindCredential, credentialStatus, getAccessToken } from "../lib/credentials";
import { encryptSecret, sha256, randomToken } from "../lib/crypto";
import { HttpError, ok, readJsonBody, requireString } from "../lib/http";
import { queueMail } from "../lib/mail";
import {
  fetchOfficialRooms,
  submitOfficialReservation,
  type OfficialMember,
} from "../lib/official";
import {
  assertReservation,
  assertThreeDayWindow,
  isHalfHour,
  isIsoDate,
  minutesBetween,
  type Room,
} from "../lib/validation";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new HttpError(400, "INVALID_FIELD", `${field} 格式错误`);
  return Number(value);
}

function requireArray(value: unknown, field: string, max = 20): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, "INVALID_FIELD", `${field} 格式错误`);
  return value;
}

async function activeRooms(env: AppEnv, userId: string, date: string): Promise<Room[]> {
  return fetchOfficialRooms(env, await getAccessToken(env, userId), date);
}

function publicRoom(room: Room): Room & { reservable: boolean } {
  return { ...room, reservable: room.maxNum !== 8 && room.maxNum !== 12 };
}

async function resolveMembers(env: AppEnv, owner: User, memberUserIds: unknown): Promise<OfficialMember[]> {
  const values = requireArray(memberUserIds ?? [], "memberUserIds", 12);
  const ids = [...new Set(values.map((value) => requireString(value, "memberUserIds", 80)))];
  if (ids.includes(owner.id)) throw new HttpError(400, "INVALID_MEMBERS", "主预约人不能作为副预约人");
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, student_id, real_name, allow_auto_join_reservation
       FROM users WHERE id IN (${placeholders}) AND status = 'ACTIVE'`,
  ).bind(...ids).all<{ id: string; student_id: string | null; real_name: string | null; allow_auto_join_reservation: number }>();
  if (rows.results.length !== ids.length) throw new HttpError(400, "INVALID_MEMBERS", "副预约人不存在或不可用");
  return rows.results.map((row) => {
    if (!row.student_id || !row.real_name) throw new HttpError(400, "MEMBER_UNBOUND", "副预约人尚未绑定官方身份");
    if (!row.allow_auto_join_reservation) throw new HttpError(409, "MEMBER_APPROVAL_REQUIRED", "副预约人尚未授权自动联约，请先创建邀请");
    return { userId: row.student_id, userName: row.real_name };
  });
}

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

export async function me(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  return ok({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      studentId: user.student_id,
      realName: user.real_name,
      allowAutoJoinReservation: Boolean(user.allow_auto_join_reservation),
      squareVisibility: user.square_visibility,
    },
    credential: await credentialStatus(env, user.id),
  });
}

export async function health(env: AppEnv): Promise<Response> {
  const database = await env.DB.prepare("SELECT 1 AS value").first<{ value: number }>();
  return ok({
    service: "njau-libyy",
    environment: env.ENVIRONMENT,
    version: env.APP_VERSION,
    database: database?.value === 1 ? "ready" : "unavailable",
    config: {
      officialApiConfigured: Boolean(env.LIBYY_APP_SECRET),
      smtpConfigured: Boolean(env.SMTP_PASSWORD),
      emailDeliveryEnabled: flag(env, "EMAIL_DELIVERY_ENABLED"),
      reservationSubmissionEnabled: flag(env, "ENABLE_OFFICIAL_RESERVATION_SUBMISSION"),
      signParameterIngestEnabled: flag(env, "ENABLE_SIGN_PARAMETER_INGEST"),
      signoutSubmissionEnabled: flag(env, "ENABLE_SIGNOUT_SUBMISSION"),
    },
  });
}

export async function deleteAccount(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, user.id),
    env.DB.prepare("DELETE FROM official_credentials WHERE user_id = ?").bind(user.id),
    env.DB.prepare("UPDATE reservation_tasks SET status = 'CANCELLED', updated_at = ? WHERE owner_user_id = ? AND status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED')").bind(now, user.id),
    env.DB.prepare("UPDATE users SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ?").bind(now, now, user.id),
  ]);
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "ACCOUNT_DELETED", targetType: "USER", targetId: user.id, result: "SUCCESS" });
  const response = ok({ deleted: true });
  response.headers.set("set-cookie", await revokeSession(env, request));
  return response;
}

export async function bind(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  await bindCredential(env, user, requireString(body.reflushToken, "reflushToken", 8192));
  return ok({ bound: true });
}

export async function getCredentialStatus(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  return ok(await credentialStatus(env, user.id));
}

export async function rooms(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const date = requireString(new URL(request.url).searchParams.get("date"), "date", 10);
  assertThreeDayWindow(date);
  return ok({ date, rooms: (await activeRooms(env, user.id, date)).map(publicRoom) });
}

export async function manualReservation(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const date = requireString(body.date, "date", 10);
  assertThreeDayWindow(date);
  const roomId = requireInteger(body.roomId, "roomId");
  const startTime = requireString(body.startTime, "startTime", 5);
  const endTime = requireString(body.endTime, "endTime", 5);
  const members = await resolveMembers(env, user, body.memberUserIds);
  const token = await getAccessToken(env, user.id);
  const room = (await fetchOfficialRooms(env, token, date)).find((item) => item.id === roomId);
  if (!room) throw new HttpError(404, "ROOM_NOT_FOUND", "未找到该房间");
  const duration = assertReservation(room, { date, startTime, endTime, memberCount: members.length }, false);
  await localReservationLimits(env, user.id, date, duration);
  if (!flag(env, "ENABLE_OFFICIAL_RESERVATION_SUBMISSION")) {
    throw new HttpError(503, "RESERVATION_SUBMISSION_DISABLED", "预约成功响应契约尚未补齐，官方提交当前保持关闭");
  }

  const officialResponse = await submitOfficialReservation(env, token, {
    roomId,
    date,
    startTime,
    endTime,
    useDescription: "小组学习",
    members,
  });
  const now = Date.now();
  const reservationId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO reservations
      (id, owner_user_id, room_id, room_name_snapshot, date, start_time, end_time,
       member_snapshot_json, submission_type, status, official_response_json_redacted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', 'SUBMITTED_UNVERIFIED', ?, ?, ?)`,
  ).bind(reservationId, user.id, room.id, room.name, date, startTime, endTime, JSON.stringify(members), JSON.stringify({
    received: officialResponse !== null,
    responseType: Array.isArray(officialResponse) ? "array" : typeof officialResponse,
  }), now, now).run();
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "MANUAL_RESERVATION_SUBMITTED", targetType: "RESERVATION", targetId: reservationId, result: "SUBMITTED_UNVERIFIED" });
  return ok({ id: reservationId, status: "SUBMITTED_UNVERIFIED", note: "等待补齐官方成功响应契约后确认订单字段" });
}

export async function reservationHistory(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT id, task_id, official_reservation_id, room_id, room_name_snapshot, date,
            start_time, end_time, member_snapshot_json, submission_type, status, created_at
       FROM reservations WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 100`,
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function reservationDetail(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireUser(env, request);
  const row = await env.DB.prepare(
    `SELECT id, task_id, official_reservation_id, room_id, room_name_snapshot, date,
            start_time, end_time, member_snapshot_json, submission_type, status, created_at, updated_at
       FROM reservations WHERE id = ? AND owner_user_id = ?`,
  ).bind(reservationId, user.id).first();
  if (!row) throw new HttpError(404, "RESERVATION_NOT_FOUND", "未找到预约记录");
  return ok(row);
}

export async function createTask(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const targetDate = requireString(body.targetDate, "targetDate", 10);
  const startTime = requireString(body.startTime, "startTime", 5);
  const endTime = requireString(body.endTime, "endTime", 5);
  if (!isIsoDate(targetDate)) throw new HttpError(400, "INVALID_DATE", "目标日期格式错误");
  if (!isHalfHour(startTime) || !isHalfHour(endTime)) throw new HttpError(400, "INVALID_TASK_TIME", "自动预约时间必须位于整点或半点");
  const duration = minutesBetween(startTime, endTime);
  if (duration <= 0 || duration > 120) throw new HttpError(400, "INVALID_DURATION", "单次预约时长必须大于 0 且不超过 120 分钟");

  const candidates = requireArray(body.candidateRooms, "candidateRooms", 12);
  if (candidates.length === 0) throw new HttpError(400, "CANDIDATE_ROOMS_REQUIRED", "请至少选择一个候选房间");
  const taskId = crypto.randomUUID();
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO reservation_tasks
        (id, owner_user_id, target_date, start_time, end_time, use_description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '小组学习', 'DRAFT', ?, ?)`,
    ).bind(taskId, user.id, targetDate, startTime, endTime, now, now),
  ];
  candidates.forEach((candidate, index) => {
    if (!isObject(candidate)) throw new HttpError(400, "INVALID_CANDIDATE_ROOM", "候选房间格式错误");
    statements.push(env.DB.prepare(
      `INSERT INTO reservation_task_candidate_rooms
        (id, task_id, room_id, room_name_snapshot, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), taskId, requireInteger(candidate.roomId, "roomId"), requireString(candidate.roomName, "roomName", 80), index + 1, now));
  });
  await env.DB.batch(statements);
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "RESERVATION_TASK_CREATED", targetType: "RESERVATION_TASK", targetId: taskId, result: "SUCCESS" });
  return ok({ id: taskId, status: "DRAFT" });
}

export async function listTasks(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT t.*, COALESCE(json_group_array(json_object('roomId', c.room_id, 'roomName', c.room_name_snapshot, 'priority', c.priority)), '[]') AS candidate_rooms
       FROM reservation_tasks t
       LEFT JOIN reservation_task_candidate_rooms c ON c.task_id = t.id
      WHERE t.owner_user_id = ?
      GROUP BY t.id ORDER BY t.created_at DESC`,
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function taskDetail(env: AppEnv, request: Request, taskId: string): Promise<Response> {
  const user = await requireUser(env, request);
  const task = await env.DB.prepare("SELECT * FROM reservation_tasks WHERE id = ? AND owner_user_id = ?")
    .bind(taskId, user.id).first<JsonObject>();
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "未找到自动预约任务");
  const [candidates, invitations] = await Promise.all([
    env.DB.prepare("SELECT room_id, room_name_snapshot, priority FROM reservation_task_candidate_rooms WHERE task_id = ? ORDER BY priority").bind(taskId).all(),
    env.DB.prepare("SELECT id, invitee_user_id, invitee_student_id, invitee_real_name, status, approval_source, expires_at FROM reservation_invitations WHERE task_id = ? ORDER BY created_at").bind(taskId).all(),
  ]);
  return ok({ ...task, candidateRooms: candidates.results, invitations: invitations.results });
}

export async function updateTask(env: AppEnv, request: Request, taskId: string): Promise<Response> {
  const user = await requireUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const targetDate = requireString(body.targetDate, "targetDate", 10);
  const startTime = requireString(body.startTime, "startTime", 5);
  const endTime = requireString(body.endTime, "endTime", 5);
  if (!isIsoDate(targetDate)) throw new HttpError(400, "INVALID_DATE", "目标日期格式错误");
  if (!isHalfHour(startTime) || !isHalfHour(endTime)) throw new HttpError(400, "INVALID_TASK_TIME", "自动预约时间必须位于整点或半点");
  const duration = minutesBetween(startTime, endTime);
  if (duration <= 0 || duration > 120) throw new HttpError(400, "INVALID_DURATION", "单次预约时长必须大于 0 且不超过 120 分钟");
  const result = await env.DB.prepare(
    "UPDATE reservation_tasks SET target_date = ?, start_time = ?, end_time = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND status = 'DRAFT'",
  ).bind(targetDate, startTime, endTime, Date.now(), taskId, user.id).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "TASK_STATUS_CONFLICT", "只有草稿任务可以修改");
  return ok({ id: taskId, status: "DRAFT" });
}

export async function changeTaskStatus(env: AppEnv, request: Request, taskId: string, action: "enable" | "cancel"): Promise<Response> {
  const user = await requireUser(env, request);
  const nextStatus = action === "enable" ? "WAITING_WINDOW" : "CANCELLED";
  const allowed = action === "enable" ? "('DRAFT', 'WAITING_MEMBERS')" : "('DRAFT', 'WAITING_WINDOW', 'WAITING_MEMBERS', 'READY')";
  const result = await env.DB.prepare(
    `UPDATE reservation_tasks SET status = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND status IN ${allowed}`,
  ).bind(nextStatus, Date.now(), taskId, user.id).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "TASK_STATUS_CONFLICT", "当前任务状态不允许该操作");
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: `RESERVATION_TASK_${action.toUpperCase()}`, targetType: "RESERVATION_TASK", targetId: taskId, result: "SUCCESS" });
  return ok({ id: taskId, status: nextStatus });
}

export async function squareUsers(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT id, real_name,
            CASE WHEN length(student_id) > 4 THEN substr(student_id, 1, 2) || '****' || substr(student_id, -2) ELSE '****' END AS student_id_masked,
            allow_auto_join_reservation
       FROM users
      WHERE status = 'ACTIVE' AND student_id IS NOT NULL AND square_visibility = 'VISIBLE' AND id <> ?
      ORDER BY created_at DESC LIMIT 100`,
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function autoJoin(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  if (typeof body.enabled !== "boolean") throw new HttpError(400, "INVALID_FIELD", "enabled 格式错误");
  await env.DB.prepare("UPDATE users SET allow_auto_join_reservation = ?, updated_at = ? WHERE id = ?")
    .bind(body.enabled ? 1 : 0, Date.now(), user.id)
    .run();
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "AUTO_JOIN_UPDATED", targetType: "USER", targetId: user.id, result: "SUCCESS", metadata: { enabled: body.enabled } });
  return ok({ enabled: body.enabled });
}

export async function officialUserSearch(env: AppEnv, request: Request): Promise<Response> {
  await requireUser(env, request);
  requireString(new URL(request.url).searchParams.get("q"), "q", 80);
  throw new HttpError(503, "OFFICIAL_USER_SEARCH_DISABLED", "官方用户搜索响应契约尚未补齐，当前保持关闭");
}

export async function createInvitation(env: AppEnv, request: Request): Promise<Response> {
  const inviter = await requireUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const taskId = requireString(body.taskId, "taskId", 80);
  const inviteeUserId = requireString(body.inviteeUserId, "inviteeUserId", 80);
  const task = await env.DB.prepare("SELECT id FROM reservation_tasks WHERE id = ? AND owner_user_id = ?")
    .bind(taskId, inviter.id).first();
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "未找到自动预约任务");
  const invitee = await env.DB.prepare(
    "SELECT id, email, student_id, real_name, allow_auto_join_reservation FROM users WHERE id = ? AND status = 'ACTIVE'",
  ).bind(inviteeUserId).first<{ id: string; email: string; student_id: string | null; real_name: string | null; allow_auto_join_reservation: number }>();
  if (!invitee?.student_id || !invitee.real_name) throw new HttpError(400, "INVITEE_NOT_AVAILABLE", "被邀请人尚未绑定官方身份");
  const autoApproved = Boolean(invitee.allow_auto_join_reservation);
  const token = randomToken();
  const invitationId = crypto.randomUUID();
  const expiresAt = Date.now() + integerVar(env, "INVITATION_TTL_SECONDS", 86_400) * 1000;
  await env.DB.prepare(
    `INSERT INTO reservation_invitations
      (id, task_id, inviter_user_id, invitee_user_id, invitee_student_id, invitee_real_name,
       status, approval_source, action_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(invitationId, taskId, inviter.id, invitee.id, invitee.student_id, invitee.real_name,
    autoApproved ? "AUTO_APPROVED" : "PENDING", autoApproved ? "AUTO_AUTHORIZATION" : "MANUAL",
    await sha256(`${env.SESSION_SECRET}:${token}`), expiresAt, Date.now()).run();
  if (!autoApproved) {
    await queueMail(env, invitee.email, "RESERVATION_INVITATION", {
      invitationId,
      actionToken: token,
      inviterName: inviter.real_name ?? inviter.email,
      expiresAt,
    });
  }
  await audit(env.DB, { actorUserId: inviter.id, actorType: "USER", action: "INVITATION_CREATED", targetType: "INVITATION", targetId: invitationId, result: autoApproved ? "AUTO_APPROVED" : "PENDING" });
  return ok({ id: invitationId, status: autoApproved ? "AUTO_APPROVED" : "PENDING" });
}

export async function receivedInvitations(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT i.id, i.task_id, i.status, i.expires_at, i.created_at,
            u.real_name AS inviter_name, t.target_date, t.start_time, t.end_time
       FROM reservation_invitations i
       JOIN users u ON u.id = i.inviter_user_id
       LEFT JOIN reservation_tasks t ON t.id = i.task_id
      WHERE i.invitee_user_id = ? ORDER BY i.created_at DESC LIMIT 100`,
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function respondInvitation(env: AppEnv, request: Request, invitationId: string, action: "accept" | "reject"): Promise<Response> {
  const user = await requireUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const invitation = await env.DB.prepare(
    "SELECT id, action_token_hash, expires_at FROM reservation_invitations WHERE id = ? AND invitee_user_id = ? AND status = 'PENDING'",
  ).bind(invitationId, user.id).first<{ id: string; action_token_hash: string; expires_at: number }>();
  if (!invitation || invitation.expires_at <= Date.now()) throw new HttpError(409, "INVITATION_NOT_PENDING", "邀请已失效或已处理");
  if (body.token !== undefined) {
    const token = requireString(body.token, "token", 200);
    if (await sha256(`${env.SESSION_SECRET}:${token}`) !== invitation.action_token_hash) {
      throw new HttpError(403, "INVALID_INVITATION_TOKEN", "邀请令牌无效");
    }
  }
  const status = action === "accept" ? "ACCEPTED" : "REJECTED";
  await env.DB.prepare("UPDATE reservation_invitations SET status = ?, responded_at = ? WHERE id = ? AND status = 'PENDING'")
    .bind(status, Date.now(), invitationId).run();
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: `INVITATION_${status}`, targetType: "INVITATION", targetId: invitationId, result: "SUCCESS" });
  return ok({ id: invitationId, status });
}

export async function signTasks(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.reservation_id, s.scheduled_at, s.status, s.parameter_received_at, s.executed_at
       FROM sign_tasks s JOIN reservations r ON r.id = s.reservation_id
      WHERE r.owner_user_id = ? ORDER BY s.scheduled_at DESC`,
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function submitSignParameters(env: AppEnv, request: Request, taskId: string): Promise<Response> {
  const user = await requireUser(env, request);
  if (!flag(env, "ENABLE_SIGN_PARAMETER_INGEST")) {
    throw new HttpError(503, "SIGN_PARAMETERS_DISABLED", "现场签到参数来源尚未接入");
  }
  const body = await readJsonBody<JsonObject>(request);
  const systemMac = requireString(body.systemMac, "systemMac", 500);
  const qrSignCheckCode = requireString(body.qrSignCheckCode, "qrSignCheckCode", 500);
  const task = await env.DB.prepare(
    `SELECT s.id FROM sign_tasks s
       JOIN reservations r ON r.id = s.reservation_id
      WHERE s.id = ? AND r.owner_user_id = ? AND s.status = 'WAITING_PARAMETERS'`,
  ).bind(taskId, user.id).first();
  if (!task) throw new HttpError(404, "SIGN_TASK_NOT_FOUND", "未找到待接收参数的签到任务");
  await env.DB.prepare(
    `UPDATE sign_tasks
        SET system_mac_ciphertext = ?, qr_check_code_ciphertext = ?,
            parameter_received_at = ?, status = 'READY'
      WHERE id = ? AND status = 'WAITING_PARAMETERS'`,
  ).bind(
    await encryptSecret(systemMac, env.TOKEN_ENCRYPTION_KEY),
    await encryptSecret(qrSignCheckCode, env.TOKEN_ENCRYPTION_KEY),
    Date.now(),
    taskId,
  ).run();
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "SIGN_PARAMETERS_RECEIVED", targetType: "SIGN_TASK", targetId: taskId, result: "READY" });
  return ok({ id: taskId, status: "READY" });
}

export async function signoutTasks(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.reservation_id, s.scheduled_at, s.status, s.attempt_count, s.executed_at
       FROM signout_tasks s JOIN reservations r ON r.id = s.reservation_id
      WHERE r.owner_user_id = ? ORDER BY s.scheduled_at DESC`,
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function dashboard(env: AppEnv, request: Request): Promise<Response> {
  await requireAdmin(env, request);
  const row = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM users WHERE status = 'ACTIVE') AS active_users,
      (SELECT COUNT(*) FROM official_credentials WHERE credential_status = 'ACTIVE') AS active_credentials,
      (SELECT COUNT(*) FROM reservation_tasks WHERE status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED')) AS open_tasks,
      (SELECT COUNT(*) FROM email_outbox WHERE status = 'PENDING') AS pending_emails`,
  ).first();
  return ok(row);
}

export async function adminConfig(env: AppEnv, request: Request): Promise<Response> {
  await requireAdmin(env, request);
  return health(env);
}

export async function adminTestEmail(env: AppEnv, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request);
  await queueMail(env, admin.email, "TEST_EMAIL", {});
  await audit(env.DB, { actorUserId: admin.id, actorType: "ADMIN", action: "TEST_EMAIL_QUEUED", targetType: "EMAIL", result: "PENDING" });
  return ok({ queued: true });
}

export async function adminCollection(env: AppEnv, request: Request, collection: string): Promise<Response> {
  await requireAdmin(env, request);
  const queries: Record<string, string> = {
    users: "SELECT id, email, role, status, student_id, real_name, allow_auto_join_reservation, created_at, last_login_at FROM users ORDER BY created_at DESC LIMIT 200",
    credentials: "SELECT user_id, credential_status, access_token_expires_seconds, access_token_obtained_at, token_version, last_refresh_success_at, refresh_failure_count, last_error_code, last_error_message FROM official_credentials ORDER BY updated_at DESC LIMIT 200",
    tasks: "SELECT * FROM reservation_tasks ORDER BY created_at DESC LIMIT 200",
    reservations: "SELECT * FROM reservations ORDER BY created_at DESC LIMIT 200",
    invitations: "SELECT id, task_id, inviter_user_id, invitee_user_id, invitee_student_id, invitee_real_name, status, approval_source, expires_at, responded_at, created_at FROM reservation_invitations ORDER BY created_at DESC LIMIT 200",
    "sign-tasks": "SELECT id, reservation_id, scheduled_at, status, parameter_received_at, executed_at FROM sign_tasks ORDER BY scheduled_at DESC LIMIT 200",
    "signout-tasks": "SELECT id, reservation_id, official_reservation_id, scheduled_at, status, attempt_count, executed_at FROM signout_tasks ORDER BY scheduled_at DESC LIMIT 200",
    emails: "SELECT id, recipient_email, template, status, attempt_count, next_attempt_at, last_error_message, created_at, sent_at FROM email_outbox ORDER BY created_at DESC LIMIT 200",
    "audit-logs": "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 300",
  };
  const sql = queries[collection];
  if (!sql) throw new HttpError(404, "NOT_FOUND", "接口不存在");
  return ok((await env.DB.prepare(sql).all()).results);
}

export async function adminUserStatus(env: AppEnv, request: Request, userId: string): Promise<Response> {
  const admin = await requireAdmin(env, request);
  const body = await readJsonBody<JsonObject>(request);
  if (body.status !== "ACTIVE" && body.status !== "BANNED") throw new HttpError(400, "INVALID_STATUS", "账号状态错误");
  await env.DB.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").bind(body.status, Date.now(), userId).run();
  if (body.status === "BANNED") {
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(Date.now(), userId),
      env.DB.prepare("UPDATE official_credentials SET credential_status = 'DISABLED', updated_at = ? WHERE user_id = ?").bind(Date.now(), userId),
      env.DB.prepare("UPDATE reservation_tasks SET status = 'CANCELLED', updated_at = ? WHERE owner_user_id = ? AND status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED')").bind(Date.now(), userId),
    ]);
  }
  await audit(env.DB, { actorUserId: admin.id, actorType: "ADMIN", action: "ADMIN_USER_STATUS_UPDATED", targetType: "USER", targetId: userId, result: "SUCCESS", metadata: { status: body.status } });
  return ok({ id: userId, status: body.status });
}
