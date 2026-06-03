import type { AppEnv } from "../config";
import { flag, integerVar } from "../config";
import { currentUser, requireAdmin, requireUser, revokeSession, type User } from "../lib/auth";
import { audit } from "../lib/audit";
import { bindCredential, credentialStatus, getAccessToken, getOfficialReservationProfile } from "../lib/credentials";
import { sha256, randomToken } from "../lib/crypto";
import { HttpError, ok, readJsonBody, requireString } from "../lib/http";
import { queueMail } from "../lib/mail";
import {
  acceptOfficialReservation,
  cancelOfficialReservation,
  createOfficialQrSignCheckCode,
  fetchOfficialReservationDates,
  fetchOfficialReservationHistory,
  fetchOfficialRoomDetail,
  fetchOfficialRooms,
  judgeOfficialReservationUsers,
  searchOfficialUsers,
  signOutOfficialReservation,
  submitOfficialReservation,
  verifyOfficialRoomPolicy,
  type OfficialMember,
} from "../lib/official";
import {
  localReservationStatus,
  reservationStatusLabel,
  resolveSignDevice,
  shanghaiParts,
  syncOfficialReservationHistory,
} from "../lib/reservations";
import {
  availableTimeRanges,
  assertReservation,
  assertThreeDayWindow,
  isHalfHour,
  isIsoDate,
  minutesBetween,
  type Room,
} from "../lib/validation";

type JsonObject = Record<string, unknown>;
type DailyAvailability = {
  date: string;
  label: string;
  availableRanges: Array<{ startTime: string; endTime: string }>;
};
type ResolvedMember = OfficialMember & {
  source: "TEAM" | "CONTACT";
  localUserId?: string;
  contactId?: string;
};

const memberSourcePriority: Record<ResolvedMember["source"], number> = {
  CONTACT: 0,
  TEAM: 1,
};

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
  return { ...room, reservable: (room.status ?? 0) === 0 && room.maxNum !== 8 && room.maxNum !== 12 };
}

function publicRoomWithRanges(room: Room, date: string): Room & { reservable: boolean; availableRanges: Array<{ startTime: string; endTime: string }> } {
  return { ...publicRoom(room), availableRanges: availableTimeRanges(room, date) };
}

function shanghaiDate(offset = 0, now = new Date()): string {
  const base = new Date(now.valueOf());
  base.setUTCDate(base.getUTCDate() + offset);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(base);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function threeDayWindow(now = new Date()): Array<{ date: string; label: string }> {
  return ["今天", "明天", "后天"].map((label, index) => ({ date: shanghaiDate(index, now), label }));
}

async function roomDailyAvailability(env: AppEnv, token: string, roomId: number, dates = threeDayWindow()): Promise<DailyAvailability[]> {
  return Promise.all(dates.map(async ({ date, label }) => {
    try {
      const detail = await fetchOfficialRoomDetail(env, token, roomId, date);
      return { date, label, availableRanges: availableTimeRanges(detail, date) };
    } catch {
      return { date, label, availableRanges: [] };
    }
  }));
}

async function requireBoundUser(env: AppEnv, request: Request): Promise<User> {
  const user = await requireUser(env, request);
  const credential = await credentialStatus(env, user.id);
  if (!user.student_id || !user.real_name || credential.credential_status !== "ACTIVE") {
    throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");
  }
  return user;
}

function maskStudentId(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return value;
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

async function resolveMembers(env: AppEnv, owner: User, teamMemberUserIds: unknown, contactIds: unknown, autoJoinUserIds: unknown, allowContacts: boolean): Promise<ResolvedMember[]> {
  const teamIds = [...new Set(requireArray(teamMemberUserIds ?? [], "teamMemberUserIds", 20).map((value) => requireString(value, "teamMemberUserIds", 80)))];
  const recentIds = [...new Set(requireArray(contactIds ?? [], "contactIds", 20).map((value) => requireString(value, "contactIds", 80)))];
  const autoJoinIds = [...new Set(requireArray(autoJoinUserIds ?? [], "autoJoinUserIds", 20).map((value) => requireString(value, "autoJoinUserIds", 80)))];
  if (autoJoinIds.length) throw new HttpError(400, "AUTO_JOIN_REMOVED", "站内自动联约已停用，请使用小队成员");
  if (!allowContacts && recentIds.length) throw new HttpError(400, "CONTACTS_NOT_ALLOWED", "自动预约只能选择小队成员");
  if (teamIds.includes(owner.id)) throw new HttpError(400, "INVALID_MEMBERS", "主预约人不能作为副预约人");
  const members: ResolvedMember[] = [];
  if (teamIds.length) {
    const placeholders = teamIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT u.id, u.student_id, u.real_name
         FROM teams t
         JOIN team_members m ON m.team_id = t.id
         JOIN users u ON u.id = m.user_id
        WHERE t.leader_user_id = ? AND u.id IN (${placeholders}) AND u.status = 'ACTIVE'`,
    ).bind(owner.id, ...teamIds).all<{ id: string; student_id: string; real_name: string }>();
    if (rows.results.length !== teamIds.length) throw new HttpError(403, "TEAM_MEMBER_REQUIRED", "只能自动联约自己带领小队中的成员");
    members.push(...rows.results.map((row) => ({ userId: row.student_id, userName: row.real_name, source: "TEAM" as const, localUserId: row.id })));
  }
  if (recentIds.length) {
    const placeholders = recentIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, official_student_id, official_real_name FROM recent_contacts
        WHERE owner_user_id = ? AND id IN (${placeholders})`,
    ).bind(owner.id, ...recentIds).all<{ id: string; official_student_id: string; official_real_name: string }>();
    if (rows.results.length !== recentIds.length) throw new HttpError(400, "INVALID_CONTACTS", "最近联系人不存在");
    members.push(...rows.results.map((row) => ({ userId: row.official_student_id, userName: row.official_real_name, source: "CONTACT" as const, contactId: row.id })));
  }
  const deduped = new Map<string, ResolvedMember>();
  for (const member of members) {
    const current = deduped.get(member.userId);
    if (!current || memberSourcePriority[member.source] > memberSourcePriority[current.source]) deduped.set(member.userId, member);
  }
  return [...deduped.values()];
}

async function autoAcceptTeamMembers(env: AppEnv, officialReservationId: string, members: ResolvedMember[]): Promise<{ accepted: number; failed: number }> {
  let accepted = 0;
  let failed = 0;
  for (const member of members) {
    if (member.source !== "TEAM" || !member.localUserId) continue;
    try {
      await acceptOfficialReservation(env, await getAccessToken(env, member.localUserId), officialReservationId);
      accepted += 1;
    } catch {
      failed += 1;
    }
  }
  return { accepted, failed };
}

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

export async function me(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  return ok({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      studentId: user.student_id,
      realName: user.real_name,
      squareVisibility: user.square_visibility,
    },
    credential: await credentialStatus(env, user.id),
  });
}

export async function health(env: AppEnv): Promise<Response> {
  const database = await env.DB.prepare("SELECT 1 AS value").first<{ value: number }>();
  let signRoomSystemMacMapConfigured = false;
  let room2SignDeviceConfigured = false;
  try {
    const parsed = JSON.parse(env.SIGN_ROOM_SYSTEM_MAC_MAP?.trim() || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, unknown>);
      signRoomSystemMacMapConfigured = values.some((value) => typeof value === "string" && value.trim() !== "");
      room2SignDeviceConfigured = typeof (parsed as Record<string, unknown>)["2"] === "string"
        && String((parsed as Record<string, unknown>)["2"]).trim() !== "";
    }
  } catch {
    signRoomSystemMacMapConfigured = false;
    room2SignDeviceConfigured = false;
  }
  return ok({
    service: "njau-libyy",
    environment: env.ENVIRONMENT,
    version: env.APP_VERSION,
    database: database?.value === 1 ? "ready" : "unavailable",
    config: {
      officialApiConfigured: Boolean(env.LIBYY_APP_SECRET),
      officialProxyConfigured: Boolean(env.NJAU_PROXY_ENDPOINT && env.NJAU_PROXY_TOKEN),
      smtpConfigured: Boolean(env.SMTP_PASSWORD),
      emailDeliveryEnabled: flag(env, "EMAIL_DELIVERY_ENABLED"),
      reservationSubmissionEnabled: flag(env, "ENABLE_SINGLE_RESERVATION_SUBMISSION"),
      multiMemberReservationSubmissionEnabled: flag(env, "ENABLE_MULTIMEMBER_RESERVATION_SUBMISSION"),
      signLinkGenerationEnabled: flag(env, "ENABLE_SIGN_LINK_GENERATION"),
      signDeviceConfigured: signRoomSystemMacMapConfigured || Boolean(env.AUTHORIZED_SIGN_SYSTEM_MAC && env.AUTHORIZED_SIGN_ROOM_ID),
      signRoomSystemMacMapConfigured,
      room2SignDeviceConfigured,
      autoSignSubmissionEnabled: flag(env, "ENABLE_AUTO_SIGN_SUBMISSION"),
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
    env.DB.prepare("DELETE FROM teams WHERE leader_user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM team_members WHERE user_id = ?").bind(user.id),
    env.DB.prepare("UPDATE team_invitations SET status = 'CANCELLED', responded_at = ? WHERE invitee_user_id = ? AND status = 'PENDING'").bind(now, user.id),
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
  const user = await requireBoundUser(env, request);
  const requestedDate = new URL(request.url).searchParams.get("date");
  const date = requestedDate ? requireString(requestedDate, "date", 10) : null;
  const token = await getAccessToken(env, user.id);
  if (!date) {
    const dates = threeDayWindow();
    const dailyRooms = await Promise.all(dates.map(({ date }) => fetchOfficialRooms(env, token, date)));
    const roomMap = new Map<number, Room & { reservable: boolean }>();
    for (const room of dailyRooms.flat().map(publicRoom).filter((room) => room.reservable)) {
      if (!roomMap.has(room.id)) roomMap.set(room.id, room);
    }
    const detailed = await Promise.all([...roomMap.values()].map(async (room) => ({
      ...room,
      dailyAvailability: await roomDailyAvailability(env, token, room.id, dates),
    })));
    return ok({ dates, rooms: detailed.filter((room) => room.reservable) });
  }
  assertThreeDayWindow(date);
  const rooms = (await fetchOfficialRooms(env, token, date)).map(publicRoom).filter((room) => room.reservable);
  const detailed = await Promise.all(rooms.map(async (room) => {
    try {
      return publicRoomWithRanges(await fetchOfficialRoomDetail(env, token, room.id, date), date);
    } catch {
      return { ...room, availableRanges: [] };
    }
  }));
  return ok({ date, rooms: detailed.filter((room) => room.reservable) });
}

function isReservationExpired(date: string, endTime: string, now = Date.now()): boolean {
  return new Date(`${date}T${endTime}:00+08:00`).valueOf() <= now;
}

function canCancelReservation(row: { status: string; official_reservation_id: string | null; date: string; end_time: string }): boolean {
  return Boolean(row.official_reservation_id)
    && ["WAITING_MEMBER_CONFIRMATION", "SUBMITTED_UNVERIFIED", "SUCCESS", "SCHEDULED"].includes(row.status)
    && !isReservationExpired(row.date, row.end_time);
}

export async function roomDetail(env: AppEnv, request: Request, roomIdText: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const requestedDate = new URL(request.url).searchParams.get("date");
  const date = requestedDate ? requireString(requestedDate, "date", 10) : null;
  const roomId = Number(roomIdText);
  if (!Number.isInteger(roomId)) throw new HttpError(400, "INVALID_FIELD", "roomId 格式错误");
  const token = await getAccessToken(env, user.id);
  if (!date) {
    const dates = threeDayWindow();
    const dailyDetails = await Promise.all(dates.map(async ({ date }) => {
      try {
        return await fetchOfficialRoomDetail(env, token, roomId, date);
      } catch {
        return null;
      }
    }));
    const room = dailyDetails.find((detail): detail is Room => Boolean(detail));
    if (!room) throw new HttpError(502, "ROOM_DETAIL_UNAVAILABLE", "研讨室详情暂时不可用");
    return ok({
      ...publicRoom(room),
      dailyAvailability: dailyDetails.map((detail, index) => ({
        ...dates[index],
        availableRanges: detail ? availableTimeRanges(detail, dates[index]!.date) : [],
      })),
    });
  }
  assertThreeDayWindow(date);
  const room = publicRoom(await fetchOfficialRoomDetail(env, token, roomId, date));
  return ok({ ...room, availableRanges: availableTimeRanges(room, date) });
}

export async function manualReservation(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const date = requireString(body.date, "date", 10);
  assertThreeDayWindow(date);
  const roomId = requireInteger(body.roomId, "roomId");
  const startTime = requireString(body.startTime, "startTime", 5);
  const endTime = requireString(body.endTime, "endTime", 5);
  const members = await resolveMembers(env, user, body.teamMemberUserIds, body.contactIds, body.autoJoinUserIds, true);
  if (members.length && !flag(env, "ENABLE_MULTIMEMBER_RESERVATION_SUBMISSION")) {
    throw new HttpError(503, "MULTIMEMBER_SUBMISSION_DISABLED", "多人官方提交尚未开放，请先使用单人预约");
  }
  const token = await getAccessToken(env, user.id);
  const profile = await getOfficialReservationProfile(env, user.id, token);
  const room = await fetchOfficialRoomDetail(env, token, roomId, date);
  const duration = assertReservation(room, { date, startTime, endTime, memberCount: members.length }, true);
  await localReservationLimits(env, user.id, date, duration);
  if (!flag(env, "ENABLE_SINGLE_RESERVATION_SUBMISSION")) throw new HttpError(503, "RESERVATION_SUBMISSION_DISABLED", "单人预约提交当前保持关闭");
  if (!await verifyOfficialRoomPolicy(env, token, profile.studentId, roomId, members.map((member) => member.userId))) throw new HttpError(409, "ROOM_POLICY_REJECTED", "官方房间规则不允许本次预约");
  await judgeOfficialReservationUsers(env, token, profile.studentId, members.map((member) => member.userId), date, startTime);

  await submitOfficialReservation(env, token, {
    ownerStudentId: profile.studentId,
    mobile: profile.mobile,
    roomId,
    date,
    startTime,
    endTime,
    useDescription: "小组学习",
    members,
  });
  let records = await syncOfficialReservationHistory(env, user);
  let matched = records.find((record) => {
    const recordStart = shanghaiParts(record.startTime);
    const recordEnd = shanghaiParts(record.endTime);
    return record.roomId === roomId && recordStart.date === date && recordStart.time === startTime && recordEnd.time === endTime;
  });
  if (!matched) throw new HttpError(502, "RESERVATION_SYNC_FAILED", "官方已接收预约，但订单回读失败，请在预约历史中刷新");
  const acceptance = await autoAcceptTeamMembers(env, String(matched.id), members);
  if (acceptance.accepted) {
    records = await syncOfficialReservationHistory(env, user);
    matched = records.find((record) => record.id === matched!.id) ?? matched;
  }
  const local = await env.DB.prepare(
    "SELECT id, status FROM reservations WHERE owner_user_id = ? AND official_reservation_id = ?",
  ).bind(user.id, String(matched.id)).first<{ id: string; status: string }>();
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "MANUAL_RESERVATION_SUBMITTED", targetType: "RESERVATION", targetId: local?.id, result: "SUCCESS" });
  return ok({
    id: local?.id,
    officialReservationId: String(matched.id),
    status: local?.status ?? localReservationStatus(matched.reservationStatus),
    teamMembersAutoAccepted: acceptance.accepted,
    teamMembersPendingRetry: acceptance.failed,
  });
}

export async function reservationHistory(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  if (new URL(request.url).searchParams.get("sync") === "true") await syncOfficialReservationHistory(env, user);
  const rows = await env.DB.prepare(
    `SELECT id, task_id, official_reservation_id, room_id, room_name_snapshot, date,
            start_time, end_time, member_snapshot_json, submission_type, status, official_status, created_at
       FROM reservations WHERE owner_user_id = ? ORDER BY date DESC, start_time DESC, created_at DESC LIMIT 100`,
  ).bind(user.id).all<{
    id: string;
    task_id: string | null;
    official_reservation_id: string | null;
    room_id: number;
    room_name_snapshot: string;
    date: string;
    start_time: string;
    end_time: string;
    member_snapshot_json: string;
    submission_type: string;
    status: string;
    official_status: number | null;
    created_at: number;
  }>();
  return ok(rows.results.map((row) => ({
    ...row,
    statusLabel: reservationStatusLabel(row.status, row.official_status),
    status_label: reservationStatusLabel(row.status, row.official_status),
    canCancel: canCancelReservation(row),
    can_cancel: canCancelReservation(row),
  })));
}

export async function syncReservationHistory(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  await syncOfficialReservationHistory(env, user);
  return reservationHistory(env, request);
}

export async function cancelReservation(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const row = await env.DB.prepare(
    "SELECT official_reservation_id, date, end_time, status FROM reservations WHERE id = ? AND owner_user_id = ? AND status IN ('WAITING_MEMBER_CONFIRMATION', 'SCHEDULED', 'SUCCESS', 'SUBMITTED_UNVERIFIED')",
  ).bind(reservationId, user.id).first<{ official_reservation_id: string | null; date: string; end_time: string; status: string }>();
  if (!row || !canCancelReservation(row)) throw new HttpError(409, "RESERVATION_NOT_CANCELLABLE", "当前预约无法取消");
  await cancelOfficialReservation(env, await getAccessToken(env, user.id), row.official_reservation_id!);
  await syncOfficialReservationHistory(env, user);
  const updated = await env.DB.prepare("SELECT status FROM reservations WHERE id = ?").bind(reservationId).first<{ status: string }>();
  if (updated?.status !== "CANCELLED") throw new HttpError(502, "RESERVATION_SYNC_FAILED", "取消请求已提交，但官方状态尚未同步");
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "RESERVATION_CANCELLED", targetType: "RESERVATION", targetId: reservationId, result: "SUCCESS" });
  return ok({ id: reservationId, status: "CANCELLED" });
}

export async function reservationDetail(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const row = await env.DB.prepare(
    `SELECT id, task_id, official_reservation_id, room_id, room_name_snapshot, date,
            start_time, end_time, member_snapshot_json, submission_type, status, created_at, updated_at
       FROM reservations WHERE id = ? AND owner_user_id = ?`,
  ).bind(reservationId, user.id).first();
  if (!row) throw new HttpError(404, "RESERVATION_NOT_FOUND", "未找到预约记录");
  return ok(row);
}

export async function createTask(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
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
  const members = await resolveMembers(env, user, body.teamMemberUserIds, body.contactIds, body.autoJoinUserIds, false);
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
  members.forEach((member) => {
    statements.push(env.DB.prepare(
      `INSERT INTO reservation_task_members
        (id, task_id, source, member_user_id, contact_id, official_student_id, official_real_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), taskId, member.source, member.localUserId ?? null, member.contactId ?? null, member.userId, member.userName, now));
  });
  await env.DB.batch(statements);
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "RESERVATION_TASK_CREATED", targetType: "RESERVATION_TASK", targetId: taskId, result: "SUCCESS" });
  return ok({ id: taskId, status: "DRAFT" });
}

export async function listTasks(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
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
  const user = await requireBoundUser(env, request);
  const task = await env.DB.prepare("SELECT * FROM reservation_tasks WHERE id = ? AND owner_user_id = ?")
    .bind(taskId, user.id).first<JsonObject>();
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "未找到自动预约任务");
  const [candidates, invitations, members] = await Promise.all([
    env.DB.prepare("SELECT room_id, room_name_snapshot, priority FROM reservation_task_candidate_rooms WHERE task_id = ? ORDER BY priority").bind(taskId).all(),
    env.DB.prepare("SELECT id, invitee_user_id, invitee_student_id, invitee_real_name, status, approval_source, expires_at FROM reservation_invitations WHERE task_id = ? ORDER BY created_at").bind(taskId).all(),
    env.DB.prepare("SELECT id, source, official_student_id, official_real_name FROM reservation_task_members WHERE task_id = ? ORDER BY created_at").bind(taskId).all(),
  ]);
  return ok({ ...task, candidateRooms: candidates.results, invitations: invitations.results, members: members.results });
}

export async function updateTask(env: AppEnv, request: Request, taskId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
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
  const user = await requireBoundUser(env, request);
  if (action === "enable" && !flag(env, "ENABLE_MULTIMEMBER_RESERVATION_SUBMISSION")) {
    const member = await env.DB.prepare("SELECT id FROM reservation_task_members WHERE task_id = ? LIMIT 1").bind(taskId).first();
    if (member) throw new HttpError(503, "MULTIMEMBER_SUBMISSION_DISABLED", "多人自动预约尚未开放，请移除成员后再启用任务");
  }
  const nextStatus = action === "enable" ? "WAITING_WINDOW" : "CANCELLED";
  const allowed = action === "enable" ? "('DRAFT', 'WAITING_MEMBERS')" : "('DRAFT', 'WAITING_WINDOW', 'WAITING_MEMBERS', 'READY')";
  const result = await env.DB.prepare(
    `UPDATE reservation_tasks SET status = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND status IN ${allowed}`,
  ).bind(nextStatus, Date.now(), taskId, user.id).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "TASK_STATUS_CONFLICT", "当前任务状态不允许该操作");
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: `RESERVATION_TASK_${action.toUpperCase()}`, targetType: "RESERVATION_TASK", targetId: taskId, result: "SUCCESS" });
  return ok({ id: taskId, status: nextStatus });
}

export async function invitableUsers(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT id, student_id, real_name
       FROM users
      WHERE status = 'ACTIVE' AND student_id IS NOT NULL AND real_name IS NOT NULL AND id <> ?
      ORDER BY created_at DESC LIMIT 100`,
  ).bind(user.id).all<{ id: string; student_id: string | null; real_name: string }>();
  return ok(rows.results.map((row) => ({
    id: row.id,
    realName: row.real_name,
    real_name: row.real_name,
    studentIdMasked: maskStudentId(row.student_id),
    student_id_masked: maskStudentId(row.student_id),
  })));
}

export async function officialUserSearch(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const query = requireString(new URL(request.url).searchParams.get("q"), "q", 80);
  if (!/^[A-Za-z0-9_-]+$/.test(query)) throw new HttpError(400, "INVALID_FIELD", "请输入准确学号");
  const found = await searchOfficialUsers(env, await getAccessToken(env, user.id), query);
  if (found.userId === user.student_id) throw new HttpError(400, "INVALID_CONTACT", "不能将自己添加为联系人");
  const now = Date.now();
  const existing = await env.DB.prepare(
    "SELECT id FROM recent_contacts WHERE owner_user_id = ? AND official_student_id = ?",
  ).bind(user.id, found.userId).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await env.DB.prepare(
      "UPDATE recent_contacts SET official_real_name = ?, last_used_at = ? WHERE id = ?",
    ).bind(found.realName, now, id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO recent_contacts (id, owner_user_id, official_student_id, official_real_name, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, user.id, found.userId, found.realName, now, now).run();
  }
  await env.DB.prepare(
    `DELETE FROM recent_contacts WHERE owner_user_id = ? AND id NOT IN (
       SELECT id FROM recent_contacts WHERE owner_user_id = ? ORDER BY last_used_at DESC LIMIT 20
     )`,
  ).bind(user.id, user.id).run();
  return ok({ id, studentId: found.userId, realName: found.realName });
}

export async function recentContacts(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const rows = await env.DB.prepare(
    "SELECT id, official_student_id AS studentId, official_real_name AS realName, last_used_at AS lastUsedAt FROM recent_contacts WHERE owner_user_id = ? ORDER BY last_used_at DESC LIMIT 20",
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function createTeam(env: AppEnv, request: Request): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const name = requireString(body.name, "name", 40);
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 240) : "";
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO teams (id, leader_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, leader.id, name, description, now, now).run();
  } catch {
    throw new HttpError(409, "TEAM_ALREADY_OWNED", "每位用户最多创建一个小队");
  }
  await audit(env.DB, { actorUserId: leader.id, actorType: "USER", action: "TEAM_CREATED", targetType: "TEAM", targetId: id, result: "SUCCESS" });
  return ok({ id, name, description });
}

export async function listMyTeams(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const [teams, invitations] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.name, t.description, t.leader_user_id,
              leader.real_name AS leader_name,
              CASE WHEN t.leader_user_id = ? THEN 1 ELSE 0 END AS is_leader,
              COALESCE(json_group_array(CASE WHEN member.id IS NULL THEN NULL ELSE json_object('id', member.id, 'realName', member.real_name) END), '[]') AS members
         FROM teams t
         JOIN users leader ON leader.id = t.leader_user_id
         LEFT JOIN team_members tm ON tm.team_id = t.id
         LEFT JOIN users member ON member.id = tm.user_id
        WHERE t.leader_user_id = ? OR EXISTS (SELECT 1 FROM team_members mine WHERE mine.team_id = t.id AND mine.user_id = ?)
        GROUP BY t.id ORDER BY t.created_at DESC`,
    ).bind(user.id, user.id, user.id).all(),
    env.DB.prepare(
      `SELECT i.id, i.team_id, i.status, i.expires_at, i.created_at, t.name AS team_name, u.real_name AS inviter_name
         FROM team_invitations i JOIN teams t ON t.id = i.team_id JOIN users u ON u.id = i.inviter_user_id
        WHERE i.invitee_user_id = ? ORDER BY i.created_at DESC LIMIT 100`,
    ).bind(user.id).all(),
  ]);
  return ok({ teams: teams.results, invitations: invitations.results });
}

export async function inviteTeamMember(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const inviteeUserId = requireString(body.inviteeUserId, "inviteeUserId", 80);
  if (inviteeUserId === leader.id) throw new HttpError(400, "INVALID_INVITEE", "不能邀请自己加入小队");
  const team = await env.DB.prepare("SELECT id, name FROM teams WHERE id = ? AND leader_user_id = ?").bind(teamId, leader.id).first<{ id: string; name: string }>();
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "未找到自己创建的小队");
  const invitee = await env.DB.prepare("SELECT id, email, real_name FROM users WHERE id = ? AND status = 'ACTIVE' AND student_id IS NOT NULL")
    .bind(inviteeUserId).first<{ id: string; email: string; real_name: string }>();
  if (!invitee) throw new HttpError(404, "INVITEE_NOT_AVAILABLE", "被邀请用户尚未完成官方绑定");
  const member = await env.DB.prepare("SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, invitee.id).first();
  if (member) throw new HttpError(409, "TEAM_MEMBER_EXISTS", "该用户已经在小队中");
  const existing = await env.DB.prepare("SELECT id FROM team_invitations WHERE team_id = ? AND invitee_user_id = ? AND status = 'PENDING'")
    .bind(teamId, invitee.id).first();
  if (existing) throw new HttpError(409, "TEAM_INVITATION_EXISTS", "该用户已有待处理邀请");
  const token = randomToken();
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + integerVar(env, "TEAM_INVITATION_TTL_SECONDS", 604_800) * 1000;
  await env.DB.prepare(
    `INSERT INTO team_invitations
      (id, team_id, inviter_user_id, invitee_user_id, status, action_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
  ).bind(id, teamId, leader.id, invitee.id, await sha256(`${env.SESSION_SECRET}:${token}`), expiresAt, Date.now()).run();
  await queueMail(env, invitee.email, "TEAM_INVITATION", {
    inviterName: leader.real_name ?? leader.email,
    teamName: team.name,
    confirmationUrl: `${env.APP_BASE_URL}/?teamInvitation=${encodeURIComponent(id)}&teamToken=${encodeURIComponent(token)}`,
    expiresAt,
  });
  await audit(env.DB, { actorUserId: leader.id, actorType: "USER", action: "TEAM_INVITATION_CREATED", targetType: "TEAM_INVITATION", targetId: id, result: "PENDING" });
  return ok({ id, status: "PENDING" });
}

async function acceptTeamInvitation(env: AppEnv, invitationId: string, invitation: { team_id: string; invitee_user_id: string }): Promise<void> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?").bind(invitation.team_id).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= 20) throw new HttpError(409, "TEAM_FULL", "小队成员已满");
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)").bind(invitation.team_id, invitation.invitee_user_id, Date.now()),
    env.DB.prepare("UPDATE team_invitations SET status = 'ACCEPTED', responded_at = ? WHERE id = ? AND status = 'PENDING'").bind(Date.now(), invitationId),
  ]);
}

export async function teamInvitationPreview(env: AppEnv, request: Request, invitationId: string): Promise<Response> {
  const token = requireString(new URL(request.url).searchParams.get("token"), "token", 500);
  const invitation = await env.DB.prepare(
    `SELECT i.id, i.status, i.expires_at, i.action_token_hash, t.name AS team_name, u.real_name AS inviter_name
       FROM team_invitations i JOIN teams t ON t.id = i.team_id JOIN users u ON u.id = i.inviter_user_id WHERE i.id = ?`,
  ).bind(invitationId).first<{ id: string; status: string; expires_at: number; action_token_hash: string; team_name: string; inviter_name: string }>();
  if (!invitation || await sha256(`${env.SESSION_SECRET}:${token}`) !== invitation.action_token_hash) throw new HttpError(403, "INVALID_INVITATION_TOKEN", "邀请链接无效");
  return ok({ id: invitation.id, status: invitation.status, expiresAt: invitation.expires_at, teamName: invitation.team_name, inviterName: invitation.inviter_name });
}

export async function respondTeamInvitation(env: AppEnv, request: Request, invitationId: string): Promise<Response> {
  const body = await readJsonBody<JsonObject>(request);
  if (body.action !== "accept" && body.action !== "reject") throw new HttpError(400, "INVALID_FIELD", "action 格式错误");
  const invitation = await env.DB.prepare(
    "SELECT id, team_id, invitee_user_id, action_token_hash, expires_at FROM team_invitations WHERE id = ? AND status = 'PENDING'",
  ).bind(invitationId).first<{ id: string; team_id: string; invitee_user_id: string; action_token_hash: string; expires_at: number }>();
  if (!invitation || invitation.expires_at <= Date.now()) throw new HttpError(409, "INVITATION_NOT_PENDING", "邀请已失效或已处理");
  const user = await currentUser(env, request);
  const token = typeof body.token === "string" ? body.token : "";
  if (user?.id !== invitation.invitee_user_id && await sha256(`${env.SESSION_SECRET}:${token}`) !== invitation.action_token_hash) {
    throw new HttpError(403, "INVALID_INVITATION_TOKEN", "邀请链接无效");
  }
  if (body.action === "accept") await acceptTeamInvitation(env, invitationId, invitation);
  else await env.DB.prepare("UPDATE team_invitations SET status = 'REJECTED', responded_at = ? WHERE id = ? AND status = 'PENDING'").bind(Date.now(), invitationId).run();
  await audit(env.DB, { actorUserId: invitation.invitee_user_id, actorType: "USER", action: `TEAM_INVITATION_${String(body.action).toUpperCase()}`, targetType: "TEAM_INVITATION", targetId: invitationId, result: "SUCCESS" });
  return ok({ id: invitationId, status: body.action === "accept" ? "ACCEPTED" : "REJECTED" });
}

export async function leaveTeam(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const result = await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, user.id).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "TEAM_MEMBERSHIP_NOT_FOUND", "未加入该小队");
  return ok({ left: true });
}

export async function removeTeamMember(env: AppEnv, request: Request, teamId: string, memberUserId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const team = await env.DB.prepare("SELECT id FROM teams WHERE id = ? AND leader_user_id = ?").bind(teamId, leader.id).first();
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "未找到自己创建的小队");
  await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, memberUserId).run();
  return ok({ removed: true });
}

export async function deleteTeam(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const result = await env.DB.prepare("DELETE FROM teams WHERE id = ? AND leader_user_id = ?").bind(teamId, leader.id).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "TEAM_NOT_FOUND", "未找到自己创建的小队");
  return ok({ deleted: true });
}

export async function createInvitation(env: AppEnv, request: Request): Promise<Response> {
  await requireBoundUser(env, request);
  throw new HttpError(410, "LEGACY_INVITATION_DEPRECATED", "旧版预约邀请已停用，请使用小队成员或最近联系人");
}

export async function receivedInvitations(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
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
  const user = await requireBoundUser(env, request);
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
  const user = await requireBoundUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.reservation_id, s.scheduled_at, s.status, s.attempt_count, s.executed_at, s.official_response_redacted
       FROM sign_tasks s JOIN reservations r ON r.id = s.reservation_id
      WHERE r.owner_user_id = ? ORDER BY s.scheduled_at DESC`,
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function createSignLink(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  if (!flag(env, "ENABLE_SIGN_LINK_GENERATION")) throw new HttpError(503, "SIGN_LINK_DISABLED", "签到入口当前保持关闭");
  await syncOfficialReservationHistory(env, user);
  const reservation = await env.DB.prepare(
    "SELECT official_reservation_id FROM reservations WHERE id = ? AND owner_user_id = ?",
  ).bind(reservationId, user.id).first<{ official_reservation_id: string | null }>();
  if (!reservation?.official_reservation_id) throw new HttpError(404, "RESERVATION_NOT_FOUND", "未找到官方预约记录");
  const token = await getAccessToken(env, user.id);
  const profile = await getOfficialReservationProfile(env, user.id, token);
  const record = (await fetchOfficialReservationHistory(env, token, profile.studentId))
    .find((item) => String(item.id) === reservation.official_reservation_id);
  if (!record || record.reservationStatus !== 21) throw new HttpError(409, "SIGN_NOT_AVAILABLE", "当前预约状态无法签到");
  if (!record.minSignTime || !record.maxSignTime || Date.now() < record.minSignTime || Date.now() > record.maxSignTime) {
    throw new HttpError(409, "SIGN_OUTSIDE_WINDOW", "当前不在官方允许的签到时间内");
  }
  const device = resolveSignDevice(env, record.roomId);
  const key = await createOfficialQrSignCheckCode(env, token, device.roomId, device.systemMac);
  const url = new URL(env.SIGN_LINK_BASE_URL);
  url.searchParams.set("systemMac", device.systemMac);
  url.searchParams.set("roomId", device.roomId);
  url.searchParams.set("key", key);
  return ok({ url: url.href, expiresAt: record.maxSignTime });
}

export async function signoutReservation(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const reservation = await env.DB.prepare(
    "SELECT official_reservation_id, room_id FROM reservations WHERE id = ? AND owner_user_id = ? AND status = 'SIGNED_IN'",
  ).bind(reservationId, user.id).first<{ official_reservation_id: string | null; room_id: number }>();
  if (!reservation?.official_reservation_id) throw new HttpError(409, "SIGNOUT_NOT_AVAILABLE", "当前预约无法签退");
  const token = await getAccessToken(env, user.id);
  const profile = await getOfficialReservationProfile(env, user.id, token);
  await signOutOfficialReservation(env, token, profile.studentId, String(reservation.room_id));
  await syncOfficialReservationHistory(env, user);
  const updated = await env.DB.prepare("SELECT status FROM reservations WHERE id = ?").bind(reservationId).first<{ status: string }>();
  if (updated?.status !== "SIGNED_OUT") throw new HttpError(502, "SIGNOUT_SYNC_FAILED", "签退请求已提交，但官方状态尚未同步");
  return ok({ id: reservationId, status: "SIGNED_OUT" });
}

export async function submitSignParameters(env: AppEnv, request: Request, taskId: string): Promise<Response> {
  await requireBoundUser(env, request);
  void taskId;
  throw new HttpError(410, "SIGN_PARAMETER_INGEST_DEPRECATED", "现场参数注入已停用，系统会即时生成短效签到码");
}

export async function signoutTasks(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.reservation_id, s.scheduled_at, s.status, s.attempt_count, s.executed_at, s.official_response_redacted
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
    teams: "SELECT t.id, t.name, t.description, t.leader_user_id, u.real_name AS leader_name, t.created_at FROM teams t JOIN users u ON u.id = t.leader_user_id ORDER BY t.created_at DESC LIMIT 200",
    "team-invitations": "SELECT id, team_id, inviter_user_id, invitee_user_id, status, expires_at, responded_at, created_at FROM team_invitations ORDER BY created_at DESC LIMIT 200",
    "sign-tasks": "SELECT id, reservation_id, scheduled_at, status, attempt_count, executed_at FROM sign_tasks ORDER BY scheduled_at DESC LIMIT 200",
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
  const target = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(userId).first<{ status: string }>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "用户不存在");
  if (target.status !== "ACTIVE" && target.status !== "BANNED") throw new HttpError(400, "INVALID_STATUS_TRANSITION", "只能在活跃和封禁状态之间切换");
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
