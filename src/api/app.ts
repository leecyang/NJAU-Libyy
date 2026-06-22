import type { AppEnv } from "../config";
import { flag, integerVar } from "../config";
import { currentUser, requireAdmin, requireUser, revokeSession, type User } from "../lib/auth";
import { audit } from "../lib/audit";
import { credentialStatus, getAccessToken, getOfficialReservationProfile } from "../lib/credentials";
import { sha256, randomToken } from "../lib/crypto";
import { HttpError, json, ok, readJsonBody, requireString } from "../lib/http";
import { queueMail } from "../lib/mail";
import { publicGatewayJob, type OfficialGatewayJob } from "../lib/official-gateway-types";
import {
  acceptOfficialReservation,
  cancelOfficialReservation,
  createOfficialQrSignCheckCode,
  fetchOfficialReservationHistory,
  fetchOfficialRoomDetail,
  fetchOfficialRooms,
  judgeOfficialReservationUsers,
  searchOfficialUsers,
  submitOfficialSign,
  signOutOfficialReservation,
  submitOfficialReservation,
  verifyOfficialRoomPolicy,
  fetchOfficialUserScore,
  type OfficialMember,
  type OfficialReservationRecord,
} from "../lib/official";
import {
  createSignWorkflow,
  localReservationStatus,
  parseSignDeviceMap,
  reservationStatusLabel,
  resolveSignDevice,
  shanghaiParts,
  syncOfficialReservationHistory,
} from "../lib/reservations";
import {
  assertPrimaryReservationScore,
  fetchReservationParticipantScores,
  listReservationParticipants,
  resolveOrderedParticipants,
  type ReservationParticipant,
} from "../lib/reservation-participants";
import {
  availableTimeRanges,
  assertReservation,
  assertThreeDayWindow,
  isHalfHour,
  isIsoDate,
  minutesBetween,
  type Room,
} from "../lib/validation";
import {
  canonicalReservationSource,
  claimReservationQuota,
  moveReservationQuota,
  readUserMetrics,
  releaseReservationQuota,
  reservationQuotas,
  requestedMetricDates,
} from "../lib/user-metrics";

type JsonObject = Record<string, unknown>;
type NotificationUser = { id: string; email: string; real_name: string | null };
type DailyAvailability = {
  date: string;
  label: string;
  availableRanges: Array<{ startTime: string; endTime: string }>;
};
type RoomsSnapshot = {
  dates: Array<{ date: string; label: string }>;
  rooms: Array<Room & { reservable: boolean; dailyAvailability: DailyAvailability[] }>;
};
type ResolvedMember = OfficialMember & {
  localUserId: string;
};

type ReservationListRow = {
  id: string;
  task_id: string | null;
  official_reservation_id: string | null;
  owner_user_id: string;
  requested_by_user_id: string | null;
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
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new HttpError(400, "INVALID_FIELD", `${field} 格式错误`);
  return Number(value);
}

function publicRoom(room: Room): Room & { reservable: boolean } {
  return { ...room, reservable: (room.status ?? 0) === 0 && room.maxNum !== 8 && room.maxNum !== 12 };
}

function publicRoomWithRanges(room: Room, date: string): Room & { reservable: boolean; availableRanges: Array<{ startTime: string; endTime: string }> } {
  return { ...publicRoom(room), availableRanges: availableTimeRanges(room, date) };
}

function requireSecret(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new HttpError(400, "INVALID_FIELD", `${field} 格式错误`);
  }
  return value;
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

function roomsSnapshotKey(now = new Date()): string {
  return `global:rooms:${shanghaiDate(0, now)}`;
}

function userScoreSnapshotKey(userId: string): string {
  return `user:${userId}:score`;
}

function userReservationsSnapshotKey(userId: string): string {
  return `user:${userId}:reservations`;
}

function requireGateway(env: AppEnv) {
  if (!env.OFFICIAL_GATEWAY) throw new HttpError(503, "OFFICIAL_GATEWAY_UNAVAILABLE", "官方访问网关尚未启动");
  return env.OFFICIAL_GATEWAY;
}

async function userById(env: AppEnv, userId: string): Promise<User> {
  const user = await env.DB.prepare(
    `SELECT id, email, role, status, student_id, real_name, allow_auto_join_reservation, square_visibility
       FROM users WHERE id = ?`,
  ).bind(userId).first<User>();
  if (!user || user.status !== "ACTIVE") throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
  return user;
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

async function buildRoomsSnapshot(env: AppEnv, userId: string): Promise<RoomsSnapshot> {
  const token = await getAccessToken(env, userId);
  const dates = threeDayWindow();
  const dailyRooms = await Promise.all(dates.map(({ date }) => fetchOfficialRooms(env, token, date)));
  const roomMap = new Map<number, Room & { reservable: boolean }>();
  for (const room of dailyRooms.flat().map(publicRoom)) {
    if (!roomMap.has(room.id)) roomMap.set(room.id, room);
  }
  const rooms = await Promise.all([...roomMap.values()].map(async (room) => ({
    ...room,
    dailyAvailability: await roomDailyAvailability(env, token, room.id, dates),
  })));
  return { dates, rooms };
}

async function executeRoomsRefresh(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  const gateway = requireGateway(env);
  const key = typeof job.payload.snapshotKey === "string" ? job.payload.snapshotKey : roomsSnapshotKey();
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "房间刷新任务缺少执行账号");
  try {
    const value = await buildRoomsSnapshot(env, job.ownerUserId);
    const snapshot = await gateway.writeSnapshot({
      key,
      scope: "GLOBAL",
      kind: "ROOMS",
      value,
      freshForMs: 2 * 60_000,
      staleForMs: 30 * 60_000,
      refreshJobId: job.id,
    });
    return { snapshotKey: key, version: snapshot.version, refreshedAt: snapshot.refreshedAt };
  } catch (error) {
    await gateway.markSnapshotError(key, job.id, error instanceof HttpError ? error.code : "ROOMS_REFRESH_FAILED", error instanceof Error ? error.message : "房间状态刷新失败");
    throw error;
  }
}

async function executeUserScoreRefresh(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "积分刷新任务缺少用户");
  const user = await userById(env, job.ownerUserId);
  if (!user.student_id) throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");
  const score = await fetchOfficialUserScore(env, await getAccessToken(env, user.id), user.student_id);
  const snapshot = await requireGateway(env).writeSnapshot({
    key: userScoreSnapshotKey(user.id),
    scope: "USER",
    ownerUserId: user.id,
    kind: "USER_SCORE",
    value: score,
    freshForMs: 10 * 60_000,
    staleForMs: 6 * 60 * 60_000,
    refreshJobId: job.id,
  });
  return { snapshotKey: snapshot.key, version: snapshot.version, totalScore: score.totalScore };
}

async function executeParticipantScoresRefresh(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "成员积分刷新任务缺少用户");
  const requester = await userById(env, job.ownerUserId);
  const participants = await fetchReservationParticipantScores(env, requester);
  const snapshot = await requireGateway(env).writeSnapshot({
    key: `user:${requester.id}:reservation-participants`,
    scope: "USER",
    ownerUserId: requester.id,
    kind: "RESERVATION_PARTICIPANTS",
    value: { participants },
    freshForMs: 2 * 60_000,
    staleForMs: 30 * 60_000,
    refreshJobId: job.id,
  });
  return { snapshotKey: snapshot.key, version: snapshot.version, count: participants.length };
}

async function executeReservationsRefresh(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "预约同步任务缺少用户");
  const targetUserId = typeof job.payload.targetUserId === "string" ? job.payload.targetUserId : job.ownerUserId;
  const user = await userById(env, targetUserId);
  const records = await syncOfficialReservationHistory(env, user);
  const snapshot = await requireGateway(env).writeSnapshot({
    key: userReservationsSnapshotKey(user.id),
    scope: "USER",
    ownerUserId: user.id,
    kind: "RESERVATIONS",
    value: { count: records.length },
    freshForMs: 2 * 60_000,
    staleForMs: 30 * 60_000,
    refreshJobId: job.id,
  });
  return { snapshotKey: snapshot.key, version: snapshot.version, count: records.length };
}

type ReservationOptionWarning = { userId: string; realName: string; message: string };

const MEMBER_ACCEPT_RETRY_DELAYS_MS = [0, 1000, 2000, 4000, 6000, 8000, 10_000, 12_000, 15_000];

function shanghaiTimestamp(date: string, time: string): number {
  return new Date(`${date}T${time}:00+08:00`).valueOf();
}

async function buildReservationOptions(
  env: AppEnv,
  requester: User,
  refresh = false,
): Promise<{ options: Array<Record<string, unknown>>; warnings: ReservationOptionWarning[] }> {
  const manageable = await listReservationParticipants(env, requester);
  const manageableIds = new Set(manageable.map((participant) => participant.id));
  const warnings: ReservationOptionWarning[] = [];
  const readable = new Set<string>();
  for (const participant of manageable) {
    if (!refresh) {
      readable.add(participant.id);
      continue;
    }
    try {
      await syncOfficialReservationHistory(env, await userById(env, participant.id));
      readable.add(participant.id);
    } catch (error) {
      warnings.push({
        userId: participant.id,
        realName: participant.realName,
        message: error instanceof Error ? error.message : "预约读取失败",
      });
    }
  }

  const groups = new Map<string, {
    id: string;
    roomId: number;
    roomName: string;
    date: string;
    startTime: string;
    endTime: string;
    startTimestamp: number;
    endTimestamp: number;
    minSignTime: number | null;
    maxSignTime: number | null;
    reservationStatus: number;
    participants: Array<{ userId: string; studentId: string; realName: string; participantOrder: number; isPrimary: boolean }>;
    recordsByUser: Map<string, string>;
  }>();
  for (const participant of manageable.filter((item) => readable.has(item.id))) {
    const rows = await env.DB.prepare(
      `SELECT official_reservation_id, room_id, room_name_snapshot, date, start_time, end_time,
              member_snapshot_json, official_status
         FROM reservations
        WHERE owner_user_id = ? AND status IN ('WAITING_MEMBER_CONFIRMATION', 'SCHEDULED', 'SIGNED_IN', 'SUCCESS')
        ORDER BY date, start_time`,
    ).bind(participant.id).all<{
      official_reservation_id: string | null;
      room_id: number;
      room_name_snapshot: string;
      date: string;
      start_time: string;
      end_time: string;
      member_snapshot_json: string;
      official_status: number | null;
    }>();
    for (const row of rows.results) {
      const startTimestamp = shanghaiTimestamp(row.date, row.start_time);
      const endTimestamp = shanghaiTimestamp(row.date, row.end_time);
      if (!row.official_reservation_id || endTimestamp <= Date.now()) continue;
      let members: Array<{ userId: string; realName: string; userType: number | null; localUserId: string | null }> = [];
      try {
        const parsed = JSON.parse(row.member_snapshot_json) as unknown;
        if (Array.isArray(parsed)) members = parsed.filter(isObject).map((member) => ({
          userId: String(member.userId ?? ""),
          realName: String(member.realName ?? ""),
          userType: typeof member.userType === "number" ? member.userType : null,
          localUserId: typeof member.localUserId === "string" ? member.localUserId : null,
        })).filter((member) => member.userId);
      } catch {
        members = [];
      }
      if (!members.length || members.some((member) => !member.localUserId || !manageableIds.has(member.localUserId))) continue;
      const key = canonicalReservationSource({
        roomId: row.room_id,
        date: row.date,
        startTime: row.start_time,
        endTime: row.end_time,
        studentIds: members.map((member) => member.userId),
      });
      let group = groups.get(key);
      if (!group) {
        const ordered = [...members].sort((left, right) => Number(right.userType === 1) - Number(left.userType === 1));
        group = {
          id: key,
          roomId: row.room_id,
          roomName: row.room_name_snapshot,
          date: row.date,
          startTime: row.start_time,
          endTime: row.end_time,
          startTimestamp,
          endTimestamp,
          minSignTime: null,
          maxSignTime: null,
          reservationStatus: row.official_status ?? 21,
          participants: ordered.map((member, index) => ({
            userId: member.localUserId!,
            studentId: member.userId,
            realName: member.realName || manageable.find((item) => item.id === member.localUserId)?.realName || member.userId,
            participantOrder: index + 1,
            isPrimary: member.userType === 1 || index === 0,
          })),
          recordsByUser: new Map(),
        };
        groups.set(key, group);
      }
      group.recordsByUser.set(participant.id, row.official_reservation_id);
    }
  }
  const options = [...groups.values()].map((group) => {
    const primary = group.participants.find((participant) => participant.isPrimary) ?? group.participants[0]!;
    const anchor = group.recordsByUser.has(primary.userId)
      ? primary
      : group.participants.find((participant) => group.recordsByUser.has(participant.userId)) ?? primary;
    return {
      ...group,
      recordsByUser: undefined,
      ownerUserId: anchor.userId,
      ownerName: anchor.realName,
      officialReservationId: group.recordsByUser.get(anchor.userId),
    };
  }).filter((option) => option.officialReservationId).sort((left, right) => left.startTimestamp - right.startTimestamp);
  return { options, warnings };
}

async function executeReservationOptionsRefresh(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "预约选项刷新任务缺少用户");
  const requester = await userById(env, job.ownerUserId);
  return await buildReservationOptions(env, requester, true);
}

export function registerOfficialGatewayHandlers(env: AppEnv): void {
  const gateway = requireGateway(env);
  gateway.registerHandler("ROOMS_REFRESH", (job) => executeRoomsRefresh(env, job));
  gateway.registerHandler("USER_SCORE_REFRESH", (job) => executeUserScoreRefresh(env, job));
  gateway.registerHandler("PARTICIPANT_SCORES_REFRESH", (job) => executeParticipantScoresRefresh(env, job));
  gateway.registerHandler("RESERVATIONS_REFRESH", (job) => executeReservationsRefresh(env, job));
  gateway.registerHandler("RESERVATION_OPTIONS_REFRESH", (job) => executeReservationOptionsRefresh(env, job));
  gateway.registerHandler("MANUAL_RESERVATION", (job) => executeManualReservation(env, job));
  gateway.registerHandler("CANCEL_RESERVATION", (job) => executeCancelReservation(env, job));
  gateway.registerHandler("CREATE_SIGN_LINK", (job) => executeCreateSignLink(env, job));
  gateway.registerHandler("SIGNOUT_RESERVATION", (job) => executeSignoutReservation(env, job));
  gateway.registerHandler("RESERVATION_OPEN_DOOR", (job) => executeOpenReservationDoor(env, job));
  gateway.registerHandler("OFFICIAL_USER_SEARCH", (job) => executeOfficialUserSearch(env, job));
}

export async function reservationParticipants(env: AppEnv, request: Request): Promise<Response> {
  const requester = await requireBoundUser(env, request);
  const dates = requestedMetricDates(request);
  if (!env.OFFICIAL_GATEWAY) {
    const participants = await fetchReservationParticipantScores(env, requester);
    const quotas = await reservationQuotas(env.DB, participants.map((participant) => participant.id), dates);
    return ok({
      participants: participants.map((participant) => ({
        ...participant,
        reservationQuota: quotas.get(participant.id) ?? [],
      })),
    });
  }
  const available = await listReservationParticipants(env, requester);
  const metrics = await readUserMetrics(env, available.map((participant) => participant.id), dates);
  const participants = available.map((participant) => ({
    ...participant,
    totalScore: metrics.get(participant.id)?.totalScore ?? null,
    scoreRefreshedAt: metrics.get(participant.id)?.scoreRefreshedAt ?? null,
  }));
  const quotas = await reservationQuotas(env.DB, participants.map((participant) => participant.id), dates);
  return ok({
    participants: participants.map((participant) => ({
      ...participant,
      reservationQuota: quotas.get(participant.id) ?? [],
    })),
  });
}

export async function refreshReservationParticipants(env: AppEnv, request: Request): Promise<Response> {
  const requester = await requireBoundUser(env, request);
  if (!env.OFFICIAL_GATEWAY) return ok({ participants: await fetchReservationParticipantScores(env, requester) });
  const key = `user:${requester.id}:reservation-participants`;
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "PARTICIPANT_SCORES_REFRESH",
    lane: "READ",
    ownerUserId: requester.id,
    dedupeKey: `refresh:${key}`,
    payload: {},
    priority: 25,
  });
  await env.OFFICIAL_GATEWAY.linkSnapshotRefresh(key, job.id);
  return gatewayJobResponse(env, job, 1500);
}

export async function refreshReservationOptions(env: AppEnv, request: Request): Promise<Response> {
  const requester = await requireBoundUser(env, request);
  if (request.method === "GET") return ok(await buildReservationOptions(env, requester, false));
  if (!env.OFFICIAL_GATEWAY) return ok(await buildReservationOptions(env, requester, true));
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "RESERVATION_OPTIONS_REFRESH",
    lane: "READ",
    ownerUserId: requester.id,
    dedupeKey: `reservation-options:${requester.id}`,
    payload: {},
    priority: 20,
    maxAttempts: 1,
  });
  return gatewayJobResponse(env, job, 2500);
}

export async function createSignWorkflowTask(env: AppEnv, request: Request): Promise<Response> {
  const requester = await requireBoundUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const reservationOptionId = requireString(body.reservationOptionId, "reservationOptionId", 500);
  const signAdvanceMinutes = requireInteger(body.signAdvanceMinutes, "signAdvanceMinutes");
  const signoutAdvanceMinutes = requireInteger(body.signoutAdvanceMinutes, "signoutAdvanceMinutes");
  if (signAdvanceMinutes < 0 || signAdvanceMinutes > 60 || signoutAdvanceMinutes < 0 || signoutAdvanceMinutes > 60) {
    throw new HttpError(400, "INVALID_ADVANCE_MINUTES", "提前时间必须在 0 到 60 分钟之间");
  }
  const option = (await buildReservationOptions(env, requester, false)).options.find((candidate) => candidate.id === reservationOptionId) as {
    id: string;
    roomId: number;
    roomName: string;
    date: string;
    startTime: string;
    endTime: string;
    startTimestamp: number;
    endTimestamp: number;
    minSignTime: number | null;
    ownerUserId: string;
    officialReservationId: string;
    participants: Array<{ userId: string }>;
  } | undefined;
  if (!option) throw new HttpError(409, "RESERVATION_NOT_AVAILABLE", "所选官方预约已失效，请重新刷新");
  const anchorUserId = option.ownerUserId;
  const officialReservationId = option.officialReservationId;
  const anchor = await userById(env, anchorUserId);
  const records = await syncOfficialReservationHistory(env, anchor);
  const record = records.find((candidate) => String(candidate.id) === officialReservationId);
  if (!record || record.roomId !== option.roomId || ![12, 21, 31].includes(record.reservationStatus) || record.endTime <= Date.now()) {
    throw new HttpError(409, "RESERVATION_NOT_AVAILABLE", "所选官方预约已失效，请重新刷新");
  }
  const local = await env.DB.prepare(
    "SELECT id FROM reservations WHERE owner_user_id = ? AND official_reservation_id = ?",
  ).bind(anchorUserId, officialReservationId).first<{ id: string }>();
  const workflowId = await createSignWorkflow(env, {
    reservationId: local?.id ?? null,
    requestedByUserId: requester.id,
    anchorUserId,
    officialReservationId,
    roomId: option.roomId,
    roomName: option.roomName,
    date: option.date,
    startTime: option.startTime,
    endTime: option.endTime,
    startTimestamp: option.startTimestamp,
    endTimestamp: option.endTimestamp,
    minSignTime: record.minSignTime,
    signAdvanceMinutes,
    signoutAdvanceMinutes,
    participantUserIds: option.participants.map((participant) => participant.userId),
    replaceExisting: true,
  });
  await audit(env.DB, { actorUserId: requester.id, actorType: "USER", action: "SIGN_WORKFLOW_CREATED", targetType: "SIGN_WORKFLOW", targetId: workflowId, result: "SUCCESS" });
  return ok({ id: workflowId, status: "ACTIVE" });
}

export async function listSignWorkflows(env: AppEnv, request: Request): Promise<Response> {
  const requester = await requireBoundUser(env, request);
  const workflows = await env.DB.prepare(
    `SELECT * FROM sign_workflows
      WHERE requested_by_user_id = ? OR anchor_user_id = ?
      ORDER BY created_at DESC LIMIT 100`,
  ).bind(requester.id, requester.id).all<Record<string, unknown> & { id: string }>();
  const result: Array<Record<string, unknown>> = [];
  for (const workflow of workflows.results) {
    const participants = await env.DB.prepare(
      `SELECT p.user_id AS userId, u.real_name AS realName, p.participant_order AS participantOrder,
              p.sign_status AS signStatus, p.sign_attempt_count AS signAttemptCount,
              p.signed_at AS signedAt, p.last_error_code AS lastErrorCode,
              p.last_error_message AS lastErrorMessage
         FROM sign_workflow_participants p JOIN users u ON u.id = p.user_id
        WHERE p.workflow_id = ? ORDER BY p.participant_order`,
    ).bind(workflow.id).all();
    result.push({ ...workflow, participants: participants.results });
  }
  return ok(result);
}

export async function cancelSignWorkflow(env: AppEnv, request: Request, workflowId: string): Promise<Response> {
  const requester = await requireBoundUser(env, request);
  const result = await env.DB.prepare(
    `UPDATE sign_workflows SET status = 'CANCELLED', signout_status = 'DISABLED', updated_at = ?
      WHERE id = ? AND requested_by_user_id = ? AND status = 'ACTIVE'`,
  ).bind(Date.now(), workflowId, requester.id).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "WORKFLOW_STATUS_CONFLICT", "当前任务无法取消");
  await env.DB.prepare(
    "UPDATE sign_workflow_participants SET sign_status = 'DISABLED', updated_at = ? WHERE workflow_id = ? AND sign_status <> 'SUCCESS'",
  ).bind(Date.now(), workflowId).run();
  return ok({ id: workflowId, status: "CANCELLED" });
}

async function requireBoundUser(env: AppEnv, request: Request): Promise<User> {
  const user = await requireUser(env, request);
  const credential = await credentialStatus(env, user.id);
  if (!user.student_id || !user.real_name || credential.credential_status !== "ACTIVE" || credential.setup_required === true) {
    throw new HttpError(409, "SETUP_REQUIRED", "请先完成官方凭证配置");
  }
  return user;
}

function maskStudentId(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return value;
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

function reservationAccepted(record: OfficialReservationRecord): boolean {
  return [21, 31, 51, 53].includes(record.reservationStatus);
}

function memberAcceptanceComplete(record: OfficialReservationRecord, members: ResolvedMember[]): boolean {
  if (!members.length) return reservationAccepted(record);
  return reservationAccepted(record);
}

function matchingOfficialReservation(
  records: OfficialReservationRecord[],
  input: { officialReservationId?: string; roomId: number; date: string; startTime: string; endTime: string },
): OfficialReservationRecord | null {
  return records.find((record) => String(record.id) === input.officialReservationId)
    ?? records.find((record) => {
      const recordStart = shanghaiParts(record.startTime);
      const recordEnd = shanghaiParts(record.endTime);
      return record.roomId === input.roomId
        && recordStart.date === input.date
        && recordStart.time === input.startTime
        && recordEnd.time === input.endTime;
    })
    ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acceptTeamMembersUntilConfirmed(
  env: AppEnv,
  primaryUser: User,
  officialReservationId: string,
  members: ResolvedMember[],
  reservation: { roomId: number; date: string; startTime: string; endTime: string },
): Promise<{ accepted: number; failed: number; record: OfficialReservationRecord }> {
  let lastRecord: OfficialReservationRecord | null = null;
  let lastError: unknown = null;

  for (const delay of MEMBER_ACCEPT_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    let acceptedThisRound = 0;
    for (const member of members) {
      try {
        const memberToken = await getAccessToken(env, member.localUserId);
        const memberProfile = await getOfficialReservationProfile(env, member.localUserId, memberToken);
        const memberRecord = matchingOfficialReservation(
          await fetchOfficialReservationHistory(env, memberToken, memberProfile.studentId),
          { officialReservationId, ...reservation },
        );
        if (!memberRecord) throw new HttpError(502, "MEMBER_RESERVATION_NOT_FOUND", "成员端暂未同步到官方预约邀请");
        if (reservationAccepted(memberRecord)) {
          acceptedThisRound += 1;
          continue;
        }
        if (memberRecord.reservationStatus !== 12) {
          throw new HttpError(409, "MEMBER_RESERVATION_NOT_ACCEPTABLE", "成员端预约状态无法自动同意");
        }
        await acceptOfficialReservation(env, memberToken, String(memberRecord.id));
        const confirmed = matchingOfficialReservation(
          await fetchOfficialReservationHistory(env, memberToken, memberProfile.studentId),
          { officialReservationId: String(memberRecord.id), ...reservation },
        );
        if (confirmed && reservationAccepted(confirmed)) acceptedThisRound += 1;
      } catch (error) {
        lastError = error;
      }
    }

    const records = await syncOfficialReservationHistory(env, primaryUser);
    lastRecord = matchingOfficialReservation(records, { officialReservationId, ...reservation }) ?? lastRecord;
    if (lastRecord && acceptedThisRound === members.length && memberAcceptanceComplete(lastRecord, members)) {
      return { accepted: members.length, failed: 0, record: lastRecord };
    }

    if (acceptedThisRound < members.length) {
      console.error(JSON.stringify({
        level: "warn",
        event: "manual_reservation_member_accept_retry",
        officialReservationId,
        acceptedThisRound,
        memberCount: members.length,
        code: lastError instanceof HttpError ? lastError.code : lastError instanceof Error ? lastError.name : "MEMBER_ACCEPT_FAILED",
      }));
    }
  }

  await enqueueMemberAcceptanceTasks(env, primaryUser.id, officialReservationId, members, reservation);
  throw new HttpError(502, "MEMBER_ACCEPTANCE_INCOMPLETE", "未完成全部成员同意预约，系统会继续在后台自动同意");
}

async function enqueueMemberAcceptanceTasks(
  env: AppEnv,
  ownerUserId: string,
  officialReservationId: string,
  members: ResolvedMember[],
  reservation: { roomId: number; date: string; startTime: string; endTime: string },
): Promise<void> {
  const local = await env.DB.prepare(
    "SELECT id FROM reservations WHERE owner_user_id = ? AND official_reservation_id = ?",
  ).bind(ownerUserId, officialReservationId).first<{ id: string }>();
  const now = Date.now();
  await env.DB.batch(members.map((member) => env.DB.prepare(
    `INSERT INTO reservation_member_acceptance_tasks
      (id, reservation_id, owner_user_id, member_user_id, official_reservation_id, room_id, date, start_time, end_time,
       status, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)
     ON CONFLICT(member_user_id, official_reservation_id) DO UPDATE SET
       reservation_id = COALESCE(excluded.reservation_id, reservation_member_acceptance_tasks.reservation_id),
       owner_user_id = excluded.owner_user_id,
       official_reservation_id = excluded.official_reservation_id,
       status = CASE WHEN reservation_member_acceptance_tasks.status = 'SUCCESS' THEN 'SUCCESS' ELSE 'PENDING' END,
       next_attempt_at = excluded.next_attempt_at,
       last_error_code = NULL,
       last_error_message = NULL,
       updated_at = excluded.updated_at`,
  ).bind(
    crypto.randomUUID(),
    local?.id ?? null,
    ownerUserId,
    member.localUserId,
    officialReservationId,
    reservation.roomId,
    reservation.date,
    reservation.startTime,
    reservation.endTime,
    now,
    now,
    now,
  )));
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
  const credential = await credentialStatus(env, user.id);
  let totalScore: number | null = null;
  if (env.OFFICIAL_GATEWAY) {
    const snapshot = await env.OFFICIAL_GATEWAY.readSnapshot<{ totalScore: number }>(userScoreSnapshotKey(user.id));
    totalScore = snapshot?.value.totalScore ?? null;
  } else if (user.student_id && credential.credential_status === "ACTIVE") {
    try {
      const token = await getAccessToken(env, user.id);
      const score = await fetchOfficialUserScore(env, token, user.student_id);
      totalScore = score.totalScore;
    } catch {
      totalScore = null;
    }
  }
  const metrics = (await readUserMetrics(env, [user.id])).get(user.id);
  return ok({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      studentId: user.student_id,
      realName: user.real_name,
      squareVisibility: user.square_visibility,
      totalScore,
      scoreRefreshedAt: metrics?.scoreRefreshedAt ?? null,
      reservationQuota: metrics?.reservationQuota ?? [],
    },
    metrics: metrics ?? null,
    credential,
  });
}

export async function health(env: AppEnv): Promise<Response> {
  const database = await env.DB.prepare("SELECT 1 AS value").first<{ value: number }>();
  let signRoomSystemMacMapConfigured = false;
  let room2SignDeviceConfigured = false;
  try {
    const parsed = parseSignDeviceMap(env.SIGN_ROOM_SYSTEM_MAC_MAP);
    signRoomSystemMacMapConfigured = Object.keys(parsed).length > 0;
    room2SignDeviceConfigured = Boolean(parsed["2"]);
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
      officialGatewayEnabled: Boolean(env.OFFICIAL_GATEWAY),
      tailscaleExitNodeConfigured: String(env.TS_EXTRA_ARGS ?? "").includes("--exit-node"),
      smtpConfigured: Boolean(env.SMTP_PASSWORD),
      emailDeliveryEnabled: flag(env, "EMAIL_DELIVERY_ENABLED"),
      reservationSubmissionEnabled: flag(env, "ENABLE_SINGLE_RESERVATION_SUBMISSION"),
      multiMemberReservationSubmissionEnabled: flag(env, "ENABLE_MULTIMEMBER_RESERVATION_SUBMISSION"),
      signLinkGenerationEnabled: flag(env, "ENABLE_SIGN_LINK_GENERATION"),
      signDeviceConfigured: signRoomSystemMacMapConfigured,
      signRoomSystemMacMapConfigured,
      room2SignDeviceConfigured,
      autoSignSubmissionEnabled: flag(env, "ENABLE_AUTO_SIGN_SUBMISSION"),
      signoutSubmissionEnabled: flag(env, "ENABLE_SIGNOUT_SUBMISSION"),
    },
  });
}

export async function deleteAccount(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  await env.CAS_AUTOMATION?.removeUser(user.id);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, user.id),
    env.DB.prepare("DELETE FROM official_credentials WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM official_login_attempts WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM official_login_credentials WHERE user_id = ?").bind(user.id),
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
  if (!env.CAS_AUTOMATION) throw new HttpError(503, "CAS_AUTOMATION_UNAVAILABLE", "统一认证自动化服务未启用");
  const studentId = requireString(body.studentId, "studentId", 32);
  const password = requireSecret(body.password, "password", 128);
  const purpose = new URL(request.url).pathname.endsWith("/rebind") ? "REBIND" : "INITIAL_BIND";
  const attempt = await env.CAS_AUTOMATION.startAttempt(user.id, studentId, password, purpose);
  return json({ ok: true, data: attempt }, 202);
}

export async function refreshMe(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const job = await requireGateway(env).enqueue({
    kind: "USER_SCORE_REFRESH",
    lane: "READ",
    ownerUserId: user.id,
    dedupeKey: `refresh:${userScoreSnapshotKey(user.id)}`,
    payload: {},
    priority: 30,
  });
  await requireGateway(env).linkSnapshotRefresh(userScoreSnapshotKey(user.id), job.id);
  return json({ ok: true, data: publicGatewayJob(job) }, 202);
}

export async function submitCredentialSms(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  if (!env.CAS_AUTOMATION) throw new HttpError(503, "CAS_AUTOMATION_UNAVAILABLE", "统一认证自动化服务未启用");
  const attemptId = requireString(body.attemptId, "attemptId", 80);
  const code = requireString(body.code, "code", 6);
  return ok(await env.CAS_AUTOMATION.submitSms(user.id, attemptId, code));
}

export async function getCredentialStatus(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireUser(env, request);
  return ok(await credentialStatus(env, user.id));
}

export async function rooms(env: AppEnv, request: Request): Promise<Response> {
  const requestedDate = new URL(request.url).searchParams.get("date");
  const date = requestedDate ? requireString(requestedDate, "date", 10) : null;
  const user = await requireBoundUser(env, request);
  if (env.OFFICIAL_GATEWAY) {
    const snapshot = await env.OFFICIAL_GATEWAY.readSnapshot<RoomsSnapshot>(roomsSnapshotKey());
    const value = snapshot?.value ?? { dates: threeDayWindow(), rooms: [] };
    if (!date) {
      return ok({
        ...value,
        cache: snapshot ? {
          status: snapshot.freshness,
          version: snapshot.version,
          refreshedAt: snapshot.refreshedAt,
          refreshJobId: snapshot.refreshJobId,
          error: snapshot.lastErrorCode ? { code: snapshot.lastErrorCode, message: snapshot.lastErrorMessage } : null,
        } : { status: "MISS", version: 0, refreshedAt: null, refreshJobId: null, error: null },
      });
    }
    assertThreeDayWindow(date);
    return ok({
      date,
      rooms: value.rooms.map((room) => ({
        ...room,
        availableRanges: room.dailyAvailability.find((item) => item.date === date)?.availableRanges ?? [],
      })),
    });
  }
  const token = await getAccessToken(env, user.id);
  if (!date) {
    const dates = threeDayWindow();
    const dailyRooms = await Promise.all(dates.map(({ date }) => fetchOfficialRooms(env, token, date)));
    const roomMap = new Map<number, Room & { reservable: boolean }>();
    for (const room of dailyRooms.flat().map(publicRoom)) {
      if (!roomMap.has(room.id)) roomMap.set(room.id, room);
    }
    const detailed = await Promise.all([...roomMap.values()].map(async (room) => ({
      ...room,
      dailyAvailability: await roomDailyAvailability(env, token, room.id, dates),
    })));
    return ok({ dates, rooms: detailed });
  }
  assertThreeDayWindow(date);
  const rooms = (await fetchOfficialRooms(env, token, date)).map(publicRoom);
  const detailed = await Promise.all(rooms.map(async (room) => {
    try {
      return publicRoomWithRanges(await fetchOfficialRoomDetail(env, token, room.id, date), date);
    } catch {
      return { ...room, availableRanges: [] };
    }
  }));
  return ok({ date, rooms: detailed });
}

export async function refreshRooms(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const key = roomsSnapshotKey();
  const job = await requireGateway(env).enqueue({
    kind: "ROOMS_REFRESH",
    lane: "READ",
    ownerUserId: user.id,
    dedupeKey: `refresh:${key}`,
    payload: { snapshotKey: key },
    priority: 20,
  });
  await requireGateway(env).linkSnapshotRefresh(key, job.id);
  return json({ ok: true, data: publicGatewayJob(job) }, 202);
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
  if (env.OFFICIAL_GATEWAY) {
    const snapshot = await env.OFFICIAL_GATEWAY.readSnapshot<RoomsSnapshot>(roomsSnapshotKey());
    const room = snapshot?.value.rooms.find((item) => item.id === roomId);
    if (!room) throw new HttpError(404, "ROOM_NOT_FOUND", "缓存中没有该研讨室，请先刷新房间状态");
    if (!date) return ok(room);
    assertThreeDayWindow(date);
    return ok({
      ...room,
      availableRanges: room.dailyAvailability.find((item) => item.date === date)?.availableRanges ?? [],
    });
  }
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

async function gatewayJobResponse(env: AppEnv, job: OfficialGatewayJob, waitMs: number): Promise<Response> {
  const current = waitMs > 0 ? await requireGateway(env).waitForJob(job.id, waitMs) : job;
  return json({ ok: true, data: publicGatewayJob(current) }, current.status === "QUEUED" || current.status === "RUNNING" ? 202 : 200);
}

async function executeManualReservation(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "预约任务缺少用户");
  const requester = await userById(env, job.ownerUserId);
  const body = job.payload;
  const date = requireString(body.date, "date", 10);
  assertThreeDayWindow(date);
  const roomId = requireInteger(body.roomId, "roomId");
  const startTime = requireString(body.startTime, "startTime", 5);
  const endTime = requireString(body.endTime, "endTime", 5);
  const participants = await resolveOrderedParticipants(env, requester, body.participantUserIds);
  const primaryUserId = requireString(body.primaryUserId, "primaryUserId", 80);
  if (participants[0]?.id !== primaryUserId) throw new HttpError(400, "PRIMARY_PARTICIPANT_ORDER", "主预约人必须是第一个选中的成员");
  const primary = participants[0]!;
  const primaryUser = await userById(env, primary.id);
  await assertPrimaryReservationScore(env, primary);
  const members: ResolvedMember[] = participants.slice(1).map((participant) => ({
    userId: participant.studentId,
    userName: participant.realName,
    localUserId: participant.id,
  }));
  if (members.length && !flag(env, "ENABLE_MULTIMEMBER_RESERVATION_SUBMISSION")) {
    throw new HttpError(503, "MULTIMEMBER_SUBMISSION_DISABLED", "多人官方提交尚未开放，请先使用单人预约");
  }
  const token = await getAccessToken(env, primary.id);
  const profile = await getOfficialReservationProfile(env, primary.id, token);
  const cachedRooms = await requireGateway(env).readSnapshot<RoomsSnapshot>(roomsSnapshotKey());
  const room = cachedRooms?.value.rooms.find((item) => item.id === roomId)
    ?? await fetchOfficialRoomDetail(env, token, roomId, date);
  const duration = assertReservation(room, { date, startTime, endTime, memberCount: members.length }, true);
  await localReservationLimits(env, primary.id, date, duration);
  const quotaSource = canonicalReservationSource({
    roomId,
    date,
    startTime,
    endTime,
    studentIds: participants.map((participant) => participant.studentId),
  });
  await claimReservationQuota(env, participants.map((participant) => participant.id), date, "MANUAL", quotaSource);
  let officialSubmitted = false;
  const isStrictPostSubmitFailure = (error: unknown): boolean => error instanceof HttpError && error.code === "MEMBER_ACCEPTANCE_INCOMPLETE";
  const postSubmitWarning = async (error: unknown): Promise<Record<string, unknown>> => {
    const code = error instanceof HttpError ? error.code : "RESERVATION_POST_SUBMIT_SYNC_FAILED";
    const message = error instanceof Error ? error.message : "官方已接收预约，但本地同步暂未完成，请稍后刷新预约历史";
    console.error(JSON.stringify({
      level: "error",
      event: "manual_reservation_post_submit_failed",
      requesterId: requester.id,
      primaryUserId: primary.id,
      roomId,
      date,
      startTime,
      endTime,
      code,
    }));
    try {
      await audit(env.DB, {
        actorUserId: requester.id,
        actorType: "USER",
        action: "MANUAL_RESERVATION_SUBMITTED",
        targetType: "RESERVATION",
        result: "SUCCESS",
        metadata: { warningCode: code },
      });
    } catch {
      // The official side already accepted the reservation; audit failures must not flip the job to failed.
    }
    return {
      id: null,
      officialReservationId: null,
      status: "SUBMITTED_UNVERIFIED",
      teamMembersAutoAccepted: 0,
      teamMembersPendingRetry: members.length,
      warning: message,
      warningCode: code,
    };
  };
  try {
    if (!flag(env, "ENABLE_SINGLE_RESERVATION_SUBMISSION")) throw new HttpError(503, "RESERVATION_SUBMISSION_DISABLED", "单人预约提交当前保持关闭");
    if (!await verifyOfficialRoomPolicy(env, token, profile.studentId, roomId, members.map((member) => member.userId))) {
      throw new HttpError(409, "ROOM_POLICY_REJECTED", "官方房间规则不允许本次预约");
    }
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
    officialSubmitted = true;
    await moveReservationQuota(env, "MANUAL", quotaSource, "RESERVATION", quotaSource);
    try {
      let records = await syncOfficialReservationHistory(env, primaryUser);
      let matched = records.find((record) => {
        const recordStart = shanghaiParts(record.startTime);
        const recordEnd = shanghaiParts(record.endTime);
        return record.roomId === roomId && recordStart.date === date && recordStart.time === startTime && recordEnd.time === endTime;
      });
      if (!matched) throw new HttpError(502, "RESERVATION_SYNC_FAILED", "官方已接收预约，但订单回读失败，请在预约历史中刷新");
      let acceptance = { accepted: 0, failed: 0 };
      if (members.length) {
        const result = await acceptTeamMembersUntilConfirmed(env, primaryUser, String(matched.id), members, { roomId, date, startTime, endTime });
        acceptance = { accepted: result.accepted, failed: result.failed };
        matched = result.record;
      } else if (memberAcceptanceComplete(matched, members) === false) {
        throw new HttpError(502, "MEMBER_ACCEPTANCE_INCOMPLETE", "未完成全部成员同意预约，请稍后刷新预约历史确认");
      }
      const local = await env.DB.prepare(
        "SELECT id, status FROM reservations WHERE owner_user_id = ? AND official_reservation_id = ?",
      ).bind(primary.id, String(matched.id)).first<{ id: string; status: string }>();
      if (local?.id) {
        await env.DB.batch([
          env.DB.prepare("UPDATE reservations SET requested_by_user_id = ? WHERE id = ?").bind(requester.id, local.id),
          env.DB.prepare("UPDATE sign_workflows SET requested_by_user_id = ?, updated_at = ? WHERE reservation_id = ?")
            .bind(requester.id, Date.now(), local.id),
        ]);
      }
      await audit(env.DB, { actorUserId: requester.id, actorType: "USER", action: "MANUAL_RESERVATION_SUBMITTED", targetType: "RESERVATION", targetId: local?.id, result: "SUCCESS" });
      return {
        id: local?.id,
        officialReservationId: String(matched.id),
        status: local?.status ?? localReservationStatus(matched.reservationStatus),
        teamMembersAutoAccepted: acceptance.accepted,
        teamMembersPendingRetry: acceptance.failed,
      };
    } catch (error) {
      if (isStrictPostSubmitFailure(error)) throw error;
      return await postSubmitWarning(error);
    }
  } catch (error) {
    if (officialSubmitted) {
      if (isStrictPostSubmitFailure(error)) throw error;
      return await postSubmitWarning(error);
    }
    await releaseReservationQuota(env, "MANUAL", quotaSource);
    throw error;
  }
}

export async function manualReservation(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  const date = requireString(body.date, "date", 10);
  assertThreeDayWindow(date);
  const roomId = requireInteger(body.roomId, "roomId");
  const startTime = requireString(body.startTime, "startTime", 5);
  const endTime = requireString(body.endTime, "endTime", 5);
  if (!env.OFFICIAL_GATEWAY) {
    return ok(await executeManualReservation(env, {
      id: "direct", kind: "MANUAL_RESERVATION", lane: "WRITE", ownerUserId: user.id, dedupeKey: null,
      payload: body, status: "RUNNING", priority: 0, attemptCount: 1, maxAttempts: 1,
      availableAt: Date.now(), result: null, errorCode: null, errorMessage: null,
      createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, updatedAt: Date.now(),
    }));
  }
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "MANUAL_RESERVATION",
    lane: "WRITE",
    ownerUserId: user.id,
    dedupeKey: `manual:${user.id}:${String(body.primaryUserId ?? "")}:${date}:${roomId}:${startTime}:${endTime}`,
    payload: body,
    priority: 5,
    maxAttempts: 1,
  });
  return gatewayJobResponse(env, job, 2500);
}

function publicReservationRows(rows: ReservationListRow[]): Array<Record<string, unknown>> {
  return collapseReservationRows(rows).map((row) => ({
    ...row,
    statusLabel: reservationStatusLabel(row.status, row.official_status),
    status_label: reservationStatusLabel(row.status, row.official_status),
    canCancel: canCancelReservation(row),
    can_cancel: canCancelReservation(row),
    canOpenDoor: row.status === "SIGNED_IN",
    can_open_door: row.status === "SIGNED_IN",
  }));
}

function reservationGroupKeys(row: ReservationListRow): string[] {
  const keys = row.official_reservation_id ? [`official:${row.official_reservation_id}`] : [];
  try {
    const parsed = JSON.parse(row.member_snapshot_json) as unknown;
    if (Array.isArray(parsed)) {
      const studentIds = parsed
        .filter(isObject)
        .map((member) => typeof member.userId === "string" ? member.userId : "")
        .filter(Boolean);
      if (studentIds.length) {
        keys.push(`source:${canonicalReservationSource({
          roomId: row.room_id,
          date: row.date,
          startTime: row.start_time,
          endTime: row.end_time,
          studentIds,
        })}`);
      }
    }
  } catch {
    // Fall back to official reservation id when older snapshots cannot be parsed.
  }
  return keys.length ? keys : [`local:${row.id}`];
}

function reservationRowPriority(row: ReservationListRow): number {
  if (row.status === "SIGNED_IN") return 90;
  if (row.status === "SCHEDULED" || row.status === "SUCCESS" || row.status === "WAITING_MEMBER_CONFIRMATION") return 80;
  if (row.status === "SUBMITTED_UNVERIFIED") return 70;
  if (row.status === "SIGNED_OUT") return 50;
  if (row.status === "CANCELLED") return 10;
  return 40;
}

function collapseReservationRows(rows: ReservationListRow[]): ReservationListRow[] {
  const groups = new Map<string, ReservationListRow>();
  for (const row of rows) {
    const keys = reservationGroupKeys(row);
    const current = keys.map((key) => groups.get(key)).find((value): value is ReservationListRow => Boolean(value));
    if (!current) {
      keys.forEach((key) => groups.set(key, row));
      continue;
    }
    const currentPriority = reservationRowPriority(current);
    const rowPriority = reservationRowPriority(row);
    const selected = rowPriority > currentPriority || (rowPriority === currentPriority && row.created_at > current.created_at)
      ? row
      : current;
    [...keys, ...reservationGroupKeys(current)].forEach((key) => groups.set(key, selected));
  }
  return [...new Set(groups.values())];
}

async function reservationRowsForUser(env: AppEnv, userId: string): Promise<ReservationListRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, task_id, official_reservation_id, owner_user_id, requested_by_user_id, room_id, room_name_snapshot, date,
            start_time, end_time, member_snapshot_json, submission_type, status, official_status, created_at
       FROM reservations
      WHERE owner_user_id = ? OR requested_by_user_id = ?
      ORDER BY date DESC, start_time DESC, created_at DESC LIMIT 100`,
  ).bind(userId, userId).all<ReservationListRow>();
  return rows.results;
}

async function requireReservationOperator(env: AppEnv, requesterId: string, reservationId: string): Promise<ReservationListRow> {
  const row = await env.DB.prepare(
    `SELECT id, task_id, official_reservation_id, owner_user_id, requested_by_user_id, room_id, room_name_snapshot, date,
            start_time, end_time, member_snapshot_json, submission_type, status, official_status, created_at
       FROM reservations WHERE id = ?`,
  ).bind(reservationId).first<ReservationListRow>();
  if (!row) throw new HttpError(404, "RESERVATION_NOT_FOUND", "未找到预约记录");
  if (row.owner_user_id === requesterId || row.requested_by_user_id === requesterId) return row;
  const managed = await env.DB.prepare(
    `SELECT team.id
       FROM teams team
      WHERE team.leader_user_id = ? AND (
        EXISTS (SELECT 1 FROM team_members member WHERE member.team_id = team.id AND member.user_id = ?)
        OR EXISTS (SELECT 1 FROM team_members member WHERE member.team_id = team.id AND member.user_id = ?)
      )`,
  ).bind(requesterId, row.owner_user_id, row.requested_by_user_id ?? "").first();
  if (!managed) throw new HttpError(403, "RESERVATION_MANAGEMENT_FORBIDDEN", "无权管理这条预约");
  return row;
}

export async function reservationHistory(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  if (!env.OFFICIAL_GATEWAY && new URL(request.url).searchParams.get("sync") === "true") await syncOfficialReservationHistory(env, user);
  return ok(publicReservationRows(await reservationRowsForUser(env, user.id)));
}

export async function syncReservationHistory(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  if (env.OFFICIAL_GATEWAY) {
    const job = await env.OFFICIAL_GATEWAY.enqueue({
      kind: "RESERVATIONS_REFRESH",
      lane: "READ",
      ownerUserId: user.id,
      dedupeKey: `refresh:${userReservationsSnapshotKey(user.id)}`,
      payload: {},
      priority: 30,
    });
    await env.OFFICIAL_GATEWAY.linkSnapshotRefresh(userReservationsSnapshotKey(user.id), job.id);
    return json({ ok: true, data: publicGatewayJob(job) }, 202);
  }
  await syncOfficialReservationHistory(env, user);
  return reservationHistory(env, request);
}

export async function gatewayJobStatus(env: AppEnv, request: Request, jobId: string): Promise<Response> {
  const user = await requireUser(env, request);
  const job = await requireGateway(env).getJob(jobId);
  if (!job || (job.ownerUserId && job.ownerUserId !== user.id && user.role !== "ADMIN")) {
    throw new HttpError(404, "GATEWAY_JOB_NOT_FOUND", "访问任务不存在");
  }
  return ok(publicGatewayJob(job));
}

async function executeCancelReservation(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "取消任务缺少用户");
  const reservationId = requireString(job.payload.reservationId, "reservationId", 80);
  const requester = await userById(env, job.ownerUserId);
  const row = await requireReservationOperator(env, requester.id, reservationId);
  if (!row || !canCancelReservation(row)) throw new HttpError(409, "RESERVATION_NOT_CANCELLABLE", "当前预约无法取消");
  const owner = await userById(env, row.owner_user_id);
  await cancelOfficialReservation(env, await getAccessToken(env, owner.id), row.official_reservation_id!);
  await syncOfficialReservationHistory(env, owner);
  const updated = await env.DB.prepare("SELECT status FROM reservations WHERE id = ?").bind(reservationId).first<{ status: string }>();
  if (updated?.status !== "CANCELLED") throw new HttpError(502, "RESERVATION_SYNC_FAILED", "取消请求已提交，但官方状态尚未同步");
  await audit(env.DB, { actorUserId: requester.id, actorType: "USER", action: "RESERVATION_CANCELLED", targetType: "RESERVATION", targetId: reservationId, result: "SUCCESS" });
  return { id: reservationId, status: "CANCELLED" };
}

export async function cancelReservation(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  if (!env.OFFICIAL_GATEWAY) {
    return ok(await executeCancelReservation(env, {
      id: "direct", kind: "CANCEL_RESERVATION", lane: "WRITE", ownerUserId: user.id, dedupeKey: null,
      payload: { reservationId }, status: "RUNNING", priority: 0, attemptCount: 1, maxAttempts: 1,
      availableAt: Date.now(), result: null, errorCode: null, errorMessage: null,
      createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, updatedAt: Date.now(),
    }));
  }
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "CANCEL_RESERVATION",
    lane: "WRITE",
    ownerUserId: user.id,
    dedupeKey: `cancel:${user.id}:${reservationId}`,
    payload: { reservationId },
    priority: 4,
    maxAttempts: 1,
  });
  return gatewayJobResponse(env, job, 2000);
}

export async function reservationDetail(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const row = await env.DB.prepare(
    `SELECT id, task_id, official_reservation_id, room_id, room_name_snapshot, date,
            start_time, end_time, member_snapshot_json, submission_type, status, created_at, updated_at
       FROM reservations WHERE id = ? AND (owner_user_id = ? OR requested_by_user_id = ?)`,
  ).bind(reservationId, user.id, user.id).first();
  if (!row) throw new HttpError(404, "RESERVATION_NOT_FOUND", "未找到预约记录");
  return ok(row);
}

export async function createTask(env: AppEnv, request: Request): Promise<Response> {
  const requester = await requireBoundUser(env, request);
  const body = await readJsonBody<JsonObject>(request);
  if (Array.isArray(body.contactIds) && body.contactIds.length) throw new HttpError(400, "CONTACTS_NOT_ALLOWED", "自动预约只能选择小队成员");
  if (Array.isArray(body.autoJoinUserIds) && body.autoJoinUserIds.length) throw new HttpError(400, "AUTO_JOIN_REMOVED", "站内自动联约已停用，请使用小队成员");
  const targetDate = requireString(body.targetDate, "targetDate", 10);
  const startTime = requireString(body.startTime, "startTime", 5);
  const endTime = requireString(body.endTime, "endTime", 5);
  if (!isIsoDate(targetDate)) throw new HttpError(400, "INVALID_DATE", "目标日期格式错误");
  if (targetDate !== shanghaiDate(3)) throw new HttpError(400, "INVALID_TASK_DATE", "自动预约日期只能选择今天起第 3 天");
  if (!isHalfHour(startTime) || !isHalfHour(endTime)) throw new HttpError(400, "INVALID_TASK_TIME", "自动预约时间必须位于整点或半点");
  const duration = minutesBetween(startTime, endTime);
  if (duration <= 0 || duration > 120) throw new HttpError(400, "INVALID_DURATION", "单次预约时长必须大于 0 且不超过 120 分钟");
  const roomId = requireInteger(body.roomId, "roomId");
  const participants = await resolveOrderedParticipants(env, requester, body.participantUserIds);
  const primaryUserId = requireString(body.primaryUserId, "primaryUserId", 80);
  if (participants[0]?.id !== primaryUserId) throw new HttpError(400, "PRIMARY_PARTICIPANT_ORDER", "主预约人必须是第一个选中的成员");
  const primary = participants[0]!;
  await assertPrimaryReservationScore(env, primary);

  let room: (Room & { reservable?: boolean }) | undefined;
  if (env.OFFICIAL_GATEWAY) {
    const snapshot = await env.OFFICIAL_GATEWAY.readSnapshot<RoomsSnapshot>(roomsSnapshotKey());
    room = snapshot?.value.rooms.find((candidate) => candidate.id === roomId);
  } else {
    room = (await fetchOfficialRooms(env, await getAccessToken(env, requester.id), shanghaiDate(0))).find((candidate) => candidate.id === roomId);
  }
  if (!room || publicRoom(room).reservable === false) throw new HttpError(400, "ROOM_NOT_AVAILABLE", "请选择当前研讨间列表中的可预约房间");
  assertReservation(room, { date: targetDate, startTime, endTime, memberCount: participants.length - 1 }, true);

  const taskId = crypto.randomUUID();
  const now = Date.now();
  await claimReservationQuota(env, participants.map((participant) => participant.id), targetDate, "TASK", taskId);
  const statements = [
    env.DB.prepare(
      `INSERT INTO reservation_tasks
        (id, owner_user_id, requested_by_user_id, target_date, start_time, end_time, use_description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '小组学习', 'WAITING_WINDOW', ?, ?)`,
    ).bind(taskId, primary.id, requester.id, targetDate, startTime, endTime, now, now),
    env.DB.prepare(
      `INSERT INTO reservation_task_candidate_rooms
        (id, task_id, room_id, room_name_snapshot, priority, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).bind(crypto.randomUUID(), taskId, room.id, room.name, now),
  ];
  participants.slice(1).forEach((member, index) => {
    statements.push(env.DB.prepare(
      `INSERT INTO reservation_task_members
        (id, task_id, source, member_user_id, contact_id, official_student_id, official_real_name, participant_order, created_at)
       VALUES (?, ?, 'TEAM', ?, NULL, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), taskId, member.id, member.studentId, member.realName, index + 2, now));
  });
  try {
    await env.DB.batch(statements);
  } catch (error) {
    await releaseReservationQuota(env, "TASK", taskId);
    throw error;
  }
  await audit(env.DB, { actorUserId: requester.id, actorType: "USER", action: "RESERVATION_TASK_CREATED", targetType: "RESERVATION_TASK", targetId: taskId, result: "SUCCESS" });
  return ok({ id: taskId, status: "WAITING_WINDOW" });
}

export async function listTasks(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT t.*, COALESCE(json_group_array(json_object('roomId', c.room_id, 'roomName', c.room_name_snapshot, 'priority', c.priority)), '[]') AS candidate_rooms
       FROM reservation_tasks t
       LEFT JOIN reservation_task_candidate_rooms c ON c.task_id = t.id
      WHERE t.owner_user_id = ? OR t.requested_by_user_id = ?
      GROUP BY t.id ORDER BY t.created_at DESC`,
  ).bind(user.id, user.id).all();
  return ok(rows.results);
}

export async function taskDetail(env: AppEnv, request: Request, taskId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const task = await env.DB.prepare("SELECT * FROM reservation_tasks WHERE id = ? AND (owner_user_id = ? OR requested_by_user_id = ?)")
    .bind(taskId, user.id, user.id).first<JsonObject>();
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
    "UPDATE reservation_tasks SET target_date = ?, start_time = ?, end_time = ?, updated_at = ? WHERE id = ? AND (owner_user_id = ? OR requested_by_user_id = ?) AND status = 'DRAFT'",
  ).bind(targetDate, startTime, endTime, Date.now(), taskId, user.id, user.id).run();
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
    `UPDATE reservation_tasks SET status = ?, updated_at = ? WHERE id = ? AND (owner_user_id = ? OR requested_by_user_id = ?) AND status IN ${allowed}`,
  ).bind(nextStatus, Date.now(), taskId, user.id, user.id).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "TASK_STATUS_CONFLICT", "当前任务状态不允许该操作");
  if (action === "cancel") await releaseReservationQuota(env, "TASK", taskId);
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

async function executeOfficialUserSearch(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "联系人查询任务缺少用户");
  const user = await userById(env, job.ownerUserId);
  const query = requireString(job.payload.query, "q", 80);
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
  return { id, studentId: found.userId, realName: found.realName, totalScore: found.totalScore };
}

export async function officialUserSearch(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const query = requireString(new URL(request.url).searchParams.get("q"), "q", 80);
  if (!env.OFFICIAL_GATEWAY) {
    return ok(await executeOfficialUserSearch(env, {
      id: "direct", kind: "OFFICIAL_USER_SEARCH", lane: "READ", ownerUserId: user.id, dedupeKey: null,
      payload: { query }, status: "RUNNING", priority: 0, attemptCount: 1, maxAttempts: 1,
      availableAt: Date.now(), result: null, errorCode: null, errorMessage: null,
      createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, updatedAt: Date.now(),
    }));
  }
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "OFFICIAL_USER_SEARCH",
    lane: "READ",
    ownerUserId: user.id,
    dedupeKey: `user-search:${user.id}:${query}`,
    payload: { query },
    priority: 25,
  });
  return gatewayJobResponse(env, job, 1500);
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

async function requireOwnedTeam(env: AppEnv, leaderId: string, teamId: string): Promise<{ id: string; name: string; description: string; leader_user_id: string }> {
  const team = await env.DB.prepare(
    "SELECT id, name, description, leader_user_id FROM teams WHERE id = ? AND leader_user_id = ?",
  ).bind(teamId, leaderId).first<{ id: string; name: string; description: string; leader_user_id: string }>();
  if (!team) throw new HttpError(403, "TEAM_LEADER_REQUIRED", "只有小队队长可以查看或管理详情");
  return team;
}

async function requireOwnedTeamMember(env: AppEnv, leaderId: string, teamId: string, memberUserId: string): Promise<User> {
  const team = await requireOwnedTeam(env, leaderId, teamId);
  if (memberUserId !== team.leader_user_id) {
    const membership = await env.DB.prepare("SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?")
      .bind(teamId, memberUserId).first();
    if (!membership) throw new HttpError(404, "TEAM_MEMBERSHIP_NOT_FOUND", "该用户不在小队中");
  }
  return userById(env, memberUserId);
}

export async function teamDetail(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const team = await requireOwnedTeam(env, leader.id, teamId);
  const rows = await env.DB.prepare(
    `SELECT user.id, user.email, user.student_id, user.real_name,
            CASE WHEN user.id = ? THEN 1 ELSE 0 END AS is_leader,
            CASE WHEN user.official_mobile_ciphertext IS NOT NULL THEN 1 ELSE 0 END AS mobile_bound,
            credential.credential_status
       FROM users user
       LEFT JOIN official_credentials credential ON credential.user_id = user.id
      WHERE user.id = ? OR user.id IN (SELECT member.user_id FROM team_members member WHERE member.team_id = ?)
      ORDER BY is_leader DESC, user.real_name`,
  ).bind(team.leader_user_id, team.leader_user_id, team.id).all<{
    id: string;
    email: string;
    student_id: string | null;
    real_name: string | null;
    is_leader: number;
    mobile_bound: number;
    credential_status: string | null;
  }>();
  const metrics = await readUserMetrics(env, rows.results.map((member) => member.id));
  return ok({
    ...team,
    members: rows.results.map((member) => ({
      id: member.id,
      email: member.email,
      studentId: member.student_id,
      realName: member.real_name ?? member.email,
      isLeader: member.is_leader === 1,
      mobileBound: member.mobile_bound === 1,
      credentialStatus: member.credential_status,
      totalScore: metrics.get(member.id)?.totalScore ?? null,
      scoreRefreshedAt: metrics.get(member.id)?.scoreRefreshedAt ?? null,
      scoreStatus: metrics.get(member.id)?.scoreStatus ?? "MISS",
      reservationQuota: metrics.get(member.id)?.reservationQuota ?? [],
    })),
  });
}

export async function updateTeam(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  await requireOwnedTeam(env, leader.id, teamId);
  const body = await readJsonBody<JsonObject>(request);
  const name = requireString(body.name, "name", 40);
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 240) : "";
  await env.DB.prepare("UPDATE teams SET name = ?, description = ?, updated_at = ? WHERE id = ? AND leader_user_id = ?")
    .bind(name, description, Date.now(), teamId, leader.id).run();
  return ok({ id: teamId, name, description });
}

export async function teamMemberReservations(env: AppEnv, request: Request, teamId: string, memberUserId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const member = await requireOwnedTeamMember(env, leader.id, teamId, memberUserId);
  const snapshot = env.OFFICIAL_GATEWAY
    ? await env.OFFICIAL_GATEWAY.readSnapshot<{ count: number }>(userReservationsSnapshotKey(member.id))
    : null;
  return ok({
    member: { id: member.id, realName: member.real_name ?? member.email },
    reservations: publicReservationRows(await reservationRowsForUser(env, member.id)),
    cache: snapshot ? { status: snapshot.freshness, refreshedAt: snapshot.refreshedAt } : { status: "MISS", refreshedAt: null },
  });
}

export async function refreshTeamMemberReservations(env: AppEnv, request: Request, teamId: string, memberUserId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const member = await requireOwnedTeamMember(env, leader.id, teamId, memberUserId);
  if (!env.OFFICIAL_GATEWAY) {
    await syncOfficialReservationHistory(env, member);
    return teamMemberReservations(env, request, teamId, memberUserId);
  }
  const key = userReservationsSnapshotKey(member.id);
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "RESERVATIONS_REFRESH",
    lane: "READ",
    ownerUserId: leader.id,
    dedupeKey: `refresh:${key}`,
    payload: { targetUserId: member.id },
    priority: 30,
  });
  await env.OFFICIAL_GATEWAY.linkSnapshotRefresh(key, job.id);
  return json({ ok: true, data: publicGatewayJob(job) }, 202);
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
  }, { dedupeKey: `team-invitation:${id}:${invitee.id}` });
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
    `SELECT invitation.id, invitation.team_id, invitation.invitee_user_id, invitation.action_token_hash, invitation.expires_at,
            team.name AS team_name, leader.id AS leader_user_id, leader.email AS leader_email,
            invitee.real_name AS invitee_name, invitee.email AS invitee_email
       FROM team_invitations invitation
       JOIN teams team ON team.id = invitation.team_id
       JOIN users leader ON leader.id = team.leader_user_id
       JOIN users invitee ON invitee.id = invitation.invitee_user_id
      WHERE invitation.id = ? AND invitation.status = 'PENDING'`,
  ).bind(invitationId).first<{
    id: string;
    team_id: string;
    invitee_user_id: string;
    action_token_hash: string;
    expires_at: number;
    team_name: string;
    leader_user_id: string;
    leader_email: string;
    invitee_name: string | null;
    invitee_email: string;
  }>();
  if (!invitation || invitation.expires_at <= Date.now()) throw new HttpError(409, "INVITATION_NOT_PENDING", "邀请已失效或已处理");
  const user = await currentUser(env, request);
  const token = typeof body.token === "string" ? body.token : "";
  if (user?.id !== invitation.invitee_user_id && await sha256(`${env.SESSION_SECRET}:${token}`) !== invitation.action_token_hash) {
    throw new HttpError(403, "INVALID_INVITATION_TOKEN", "邀请链接无效");
  }
  if (body.action === "accept") await acceptTeamInvitation(env, invitationId, invitation);
  else await env.DB.prepare("UPDATE team_invitations SET status = 'REJECTED', responded_at = ? WHERE id = ? AND status = 'PENDING'").bind(Date.now(), invitationId).run();
  await queueMail(env, invitation.leader_email, body.action === "accept" ? "TEAM_INVITATION_ACCEPTED" : "TEAM_INVITATION_REJECTED", {
    teamName: invitation.team_name,
    memberName: invitation.invitee_name ?? invitation.invitee_email,
  }, { dedupeKey: `team-invitation:${invitationId}:${body.action}:${invitation.leader_user_id}` });
  await audit(env.DB, { actorUserId: invitation.invitee_user_id, actorType: "USER", action: `TEAM_INVITATION_${String(body.action).toUpperCase()}`, targetType: "TEAM_INVITATION", targetId: invitationId, result: "SUCCESS" });
  return ok({ id: invitationId, status: body.action === "accept" ? "ACCEPTED" : "REJECTED" });
}

export async function leaveTeam(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const team = await env.DB.prepare(
    `SELECT team.name, leader.id AS leader_user_id, leader.email AS leader_email
       FROM teams team JOIN users leader ON leader.id = team.leader_user_id
      WHERE team.id = ?`,
  ).bind(teamId).first<{ name: string; leader_user_id: string; leader_email: string }>();
  const result = await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, user.id).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "TEAM_MEMBERSHIP_NOT_FOUND", "未加入该小队");
  if (team) {
    await queueMail(env, team.leader_email, "TEAM_MEMBER_LEFT", {
      teamName: team.name,
      memberName: user.real_name ?? user.email,
    }, { dedupeKey: `team-member-left:${teamId}:${user.id}` });
  }
  return ok({ left: true });
}

export async function removeTeamMember(env: AppEnv, request: Request, teamId: string, memberUserId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const team = await env.DB.prepare("SELECT id, name, leader_user_id FROM teams WHERE id = ? AND leader_user_id = ?").bind(teamId, leader.id).first<{ id: string; name: string; leader_user_id: string }>();
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "未找到自己创建的小队");
  if (memberUserId === team.leader_user_id) throw new HttpError(400, "TEAM_LEADER_CANNOT_BE_REMOVED", "不能将队长移出小队");
  const member = await env.DB.prepare(
    `SELECT user.id, user.email, user.real_name
       FROM team_members member JOIN users user ON user.id = member.user_id
      WHERE member.team_id = ? AND member.user_id = ?`,
  ).bind(teamId, memberUserId).first<NotificationUser>();
  const result = await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, memberUserId).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "TEAM_MEMBERSHIP_NOT_FOUND", "该用户不在小队中");
  if (member) {
    await queueMail(env, member.email, "TEAM_MEMBER_REMOVED", {
      teamName: team.name,
      operatorName: leader.real_name ?? leader.email,
    }, { dedupeKey: `team-member-removed:${teamId}:${memberUserId}` });
  }
  return ok({ removed: true });
}

export async function deleteTeam(env: AppEnv, request: Request, teamId: string): Promise<Response> {
  const leader = await requireBoundUser(env, request);
  const team = await env.DB.prepare("SELECT id, name FROM teams WHERE id = ? AND leader_user_id = ?")
    .bind(teamId, leader.id).first<{ id: string; name: string }>();
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "未找到自己创建的小队");
  const members = await env.DB.prepare(
    `SELECT user.id, user.email, user.real_name
       FROM team_members member JOIN users user ON user.id = member.user_id
      WHERE member.team_id = ? AND user.status = 'ACTIVE'`,
  ).bind(teamId).all<NotificationUser>();
  const result = await env.DB.prepare("DELETE FROM teams WHERE id = ? AND leader_user_id = ?").bind(teamId, leader.id).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "TEAM_NOT_FOUND", "未找到自己创建的小队");
  for (const member of members.results) {
    await queueMail(env, member.email, "TEAM_DISBANDED", {
      teamName: team.name,
      operatorName: leader.real_name ?? leader.email,
    }, { dedupeKey: `team-disbanded:${teamId}:${member.id}` });
  }
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
    `SELECT s.id, s.reservation_id, s.scheduled_at, s.status, s.attempt_count, s.executed_at, s.official_response_redacted,
            r.official_reservation_id, r.room_name_snapshot, r.date, r.start_time, r.end_time
       FROM sign_tasks s JOIN reservations r ON r.id = s.reservation_id
      WHERE r.owner_user_id = ? ORDER BY s.scheduled_at DESC`,
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function createSignLink(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  if (!env.OFFICIAL_GATEWAY) {
    return ok(await executeCreateSignLink(env, {
      id: "direct", kind: "CREATE_SIGN_LINK", lane: "WRITE", ownerUserId: user.id, dedupeKey: null,
      payload: { reservationId }, status: "RUNNING", priority: 0, attemptCount: 1, maxAttempts: 1,
      availableAt: Date.now(), result: null, errorCode: null, errorMessage: null,
      createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, updatedAt: Date.now(),
    }));
  }
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "CREATE_SIGN_LINK",
    lane: "WRITE",
    ownerUserId: user.id,
    dedupeKey: `sign-link:${user.id}:${reservationId}`,
    payload: { reservationId },
    priority: 1,
    maxAttempts: 1,
  });
  return gatewayJobResponse(env, job, 3000);
}

async function executeCreateSignLink(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "签到任务缺少用户");
  const reservationId = requireString(job.payload.reservationId, "reservationId", 80);
  const user = await userById(env, job.ownerUserId);
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
  return { url: url.href, expiresAt: record.maxSignTime };
}

export async function signoutReservation(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  if (!env.OFFICIAL_GATEWAY) {
    return ok(await executeSignoutReservation(env, {
      id: "direct", kind: "SIGNOUT_RESERVATION", lane: "WRITE", ownerUserId: user.id, dedupeKey: null,
      payload: { reservationId }, status: "RUNNING", priority: 0, attemptCount: 1, maxAttempts: 1,
      availableAt: Date.now(), result: null, errorCode: null, errorMessage: null,
      createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, updatedAt: Date.now(),
    }));
  }
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "SIGNOUT_RESERVATION",
    lane: "WRITE",
    ownerUserId: user.id,
    dedupeKey: `signout:${user.id}:${reservationId}`,
    payload: { reservationId },
    priority: 1,
    maxAttempts: 1,
  });
  return gatewayJobResponse(env, job, 3000);
}

async function executeSignoutReservation(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "签退任务缺少用户");
  const reservationId = requireString(job.payload.reservationId, "reservationId", 80);
  const requester = await userById(env, job.ownerUserId);
  const reservation = await requireReservationOperator(env, requester.id, reservationId);
  if (reservation.status !== "SIGNED_IN" || !reservation.official_reservation_id) throw new HttpError(409, "SIGNOUT_NOT_AVAILABLE", "当前预约无法签退");
  const owner = await userById(env, reservation.owner_user_id);
  const token = await getAccessToken(env, owner.id);
  const profile = await getOfficialReservationProfile(env, owner.id, token);
  await signOutOfficialReservation(env, token, profile.studentId, String(reservation.room_id));
  await syncOfficialReservationHistory(env, owner);
  const updated = await env.DB.prepare("SELECT status FROM reservations WHERE id = ?").bind(reservationId).first<{ status: string }>();
  if (updated?.status !== "SIGNED_OUT") throw new HttpError(502, "SIGNOUT_SYNC_FAILED", "签退请求已提交，但官方状态尚未同步");
  return { id: reservationId, status: "SIGNED_OUT" };
}

async function executeOpenReservationDoor(env: AppEnv, job: OfficialGatewayJob): Promise<Record<string, unknown>> {
  if (!job.ownerUserId) throw new HttpError(400, "GATEWAY_JOB_OWNER_REQUIRED", "开门任务缺少用户");
  const reservationId = requireString(job.payload.reservationId, "reservationId", 80);
  const requester = await userById(env, job.ownerUserId);
  const reservation = await requireReservationOperator(env, requester.id, reservationId);
  if (reservation.status !== "SIGNED_IN") throw new HttpError(409, "DOOR_NOT_AVAILABLE", "只有已签到且未签退的预约可以开门");
  const owner = await userById(env, reservation.owner_user_id);
  const token = await getAccessToken(env, owner.id);
  const device = resolveSignDevice(env, reservation.room_id);
  const key = await createOfficialQrSignCheckCode(env, token, device.roomId, device.systemMac);
  await submitOfficialSign(env, token, device.roomId, device.systemMac, key);
  await audit(env.DB, {
    actorUserId: requester.id,
    actorType: "USER",
    action: "RESERVATION_DOOR_OPENED",
    targetType: "RESERVATION",
    targetId: reservationId,
    result: "SUCCESS",
    metadata: { ownerUserId: owner.id, roomId: reservation.room_id },
  });
  return { id: reservationId, roomId: reservation.room_id, roomName: reservation.room_name_snapshot, openedByName: owner.real_name ?? owner.email };
}

export async function openReservationDoor(env: AppEnv, request: Request, reservationId: string): Promise<Response> {
  const user = await requireBoundUser(env, request);
  await requireReservationOperator(env, user.id, reservationId);
  if (!env.OFFICIAL_GATEWAY) {
    return ok(await executeOpenReservationDoor(env, {
      id: "direct", kind: "RESERVATION_OPEN_DOOR", lane: "WRITE", ownerUserId: user.id, dedupeKey: null,
      payload: { reservationId }, status: "RUNNING", priority: 0, attemptCount: 1, maxAttempts: 1,
      availableAt: Date.now(), result: null, errorCode: null, errorMessage: null,
      createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, updatedAt: Date.now(),
    }));
  }
  const job = await env.OFFICIAL_GATEWAY.enqueue({
    kind: "RESERVATION_OPEN_DOOR",
    lane: "WRITE",
    ownerUserId: user.id,
    dedupeKey: `reservation-open-door:${user.id}:${reservationId}`,
    payload: { reservationId },
    priority: 1,
    maxAttempts: 1,
  });
  return gatewayJobResponse(env, job, 3000);
}

export async function signoutTasks(env: AppEnv, request: Request): Promise<Response> {
  const user = await requireBoundUser(env, request);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.reservation_id, s.official_reservation_id, s.scheduled_at, s.status, s.attempt_count, s.executed_at, s.official_response_redacted,
            r.room_name_snapshot, r.date, r.start_time, r.end_time
       FROM signout_tasks s JOIN reservations r ON r.id = s.reservation_id
      WHERE r.owner_user_id = ? ORDER BY s.scheduled_at DESC`,
  ).bind(user.id).all();
  return ok(rows.results);
}

export async function dashboard(env: AppEnv, request: Request): Promise<Response> {
  await requireAdmin(env, request);
  const now = Date.now();
  const today = shanghaiDate();
  const since24h = now - 24 * 60 * 60 * 1000;
  const [
    accounts,
    credentials,
    tasks,
    reservations,
    mail,
    gateway,
    sign,
    failedTasks,
    failedEmails,
    failedGatewayJobs,
    failedCredentials,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'BANNED' THEN 1 ELSE 0 END) AS banned,
        SUM(CASE WHEN role = 'ADMIN' THEN 1 ELSE 0 END) AS admins
       FROM users`,
    ).first(),
    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN credential_status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN credential_status = 'REAUTH_REQUIRED' THEN 1 ELSE 0 END) AS reauth_required,
        SUM(CASE WHEN credential_status = 'REFRESH_FAILED' THEN 1 ELSE 0 END) AS refresh_failed,
        SUM(CASE WHEN credential_status IN ('REAUTH_REQUIRED', 'REFRESH_FAILED', 'DISABLED') THEN 1 ELSE 0 END) AS problem
       FROM official_credentials`,
    ).first(),
    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('DRAFT', 'WAITING_WINDOW', 'WAITING_MEMBERS', 'READY', 'SUBMITTING') THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled
       FROM reservation_tasks`,
    ).first(),
    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN date = ? THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN status IN ('SIGNED_IN', 'RESERVED', 'SUCCESS') THEN 1 ELSE 0 END) AS active
       FROM reservations`,
    ).bind(today).first(),
    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'SENT' AND sent_at >= ? THEN 1 ELSE 0 END) AS sent_last_24h
       FROM email_outbox`,
    ).bind(since24h).first(),
    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'QUEUED' AND lane = 'READ' THEN 1 ELSE 0 END) AS read_queued,
        SUM(CASE WHEN status = 'QUEUED' AND lane IN ('WRITE', 'PLAYWRIGHT') THEN 1 ELSE 0 END) AS write_queued
       FROM official_gateway_jobs`,
    ).first(),
    env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM sign_tasks WHERE status = 'FAILED') AS failed_sign_tasks,
        (SELECT COUNT(*) FROM signout_tasks WHERE status = 'FAILED') AS failed_signout_tasks,
        (SELECT COUNT(*) FROM sign_workflows WHERE status = 'FAILED' OR signout_status = 'FAILED') AS failed_workflows`,
    ).first(),
    env.DB.prepare(
      `SELECT t.id, t.status, t.failure_code, t.failure_message, t.created_at, u.email, u.real_name
         FROM reservation_tasks t JOIN users u ON u.id = t.owner_user_id
        WHERE t.status = 'FAILED'
        ORDER BY t.updated_at DESC LIMIT 6`,
    ).all(),
    env.DB.prepare(
      `SELECT id, recipient_email, template, status, last_error_message, created_at
         FROM email_outbox
        WHERE status = 'FAILED'
        ORDER BY created_at DESC LIMIT 6`,
    ).all(),
    env.DB.prepare(
      `SELECT id, kind, lane, status, error_code, error_message, created_at
         FROM official_gateway_jobs
        WHERE status = 'FAILED'
        ORDER BY updated_at DESC LIMIT 6`,
    ).all(),
    env.DB.prepare(
      `SELECT c.user_id AS id, u.email, u.real_name, c.credential_status AS status, c.last_error_code, c.last_error_message, c.updated_at AS created_at
         FROM official_credentials c JOIN users u ON u.id = c.user_id
        WHERE c.credential_status IN ('REAUTH_REQUIRED', 'REFRESH_FAILED', 'DISABLED')
        ORDER BY c.updated_at DESC LIMIT 6`,
    ).all(),
  ]);
  const config = {
    environment: env.ENVIRONMENT,
    version: env.APP_VERSION,
    officialApiConfigured: Boolean(env.LIBYY_APP_SECRET),
    officialGatewayEnabled: Boolean(env.OFFICIAL_GATEWAY),
    smtpConfigured: Boolean(env.SMTP_PASSWORD),
    emailDeliveryEnabled: flag(env, "EMAIL_DELIVERY_ENABLED"),
    reservationSubmissionEnabled: flag(env, "ENABLE_SINGLE_RESERVATION_SUBMISSION"),
    multiMemberReservationSubmissionEnabled: flag(env, "ENABLE_MULTIMEMBER_RESERVATION_SUBMISSION"),
    signLinkGenerationEnabled: flag(env, "ENABLE_SIGN_LINK_GENERATION"),
    autoSignSubmissionEnabled: flag(env, "ENABLE_AUTO_SIGN_SUBMISSION"),
    signoutSubmissionEnabled: flag(env, "ENABLE_SIGNOUT_SUBMISSION"),
  };
  const recentFailures = [
    ...failedTasks.results.map((item) => ({ kind: "reservation-task", ...item })),
    ...failedEmails.results.map((item) => ({ kind: "email", ...item })),
    ...failedGatewayJobs.results.map((item) => ({ kind: "gateway-job", ...item })),
    ...failedCredentials.results.map((item) => ({ kind: "credential", ...item })),
  ].sort((left, right) => Number((right as { created_at?: number }).created_at ?? 0) - Number((left as { created_at?: number }).created_at ?? 0)).slice(0, 12);
  return ok({
    generatedAt: now,
    accounts,
    credentials,
    tasks,
    reservations,
    mail,
    gateway,
    sign,
    exceptions: {
      total: Number((tasks as { failed?: number | null } | null)?.failed ?? 0)
        + Number((mail as { failed?: number | null } | null)?.failed ?? 0)
        + Number((gateway as { failed?: number | null } | null)?.failed ?? 0)
        + Number((credentials as { problem?: number | null } | null)?.problem ?? 0)
        + Number((sign as { failed_sign_tasks?: number | null; failed_signout_tasks?: number | null; failed_workflows?: number | null } | null)?.failed_sign_tasks ?? 0)
        + Number((sign as { failed_sign_tasks?: number | null; failed_signout_tasks?: number | null; failed_workflows?: number | null } | null)?.failed_signout_tasks ?? 0)
        + Number((sign as { failed_sign_tasks?: number | null; failed_signout_tasks?: number | null; failed_workflows?: number | null } | null)?.failed_workflows ?? 0),
      failedTasks: (tasks as { failed?: number | null } | null)?.failed ?? 0,
      failedEmails: (mail as { failed?: number | null } | null)?.failed ?? 0,
      failedGatewayJobs: (gateway as { failed?: number | null } | null)?.failed ?? 0,
      problemCredentials: (credentials as { problem?: number | null } | null)?.problem ?? 0,
    },
    recentFailures,
    config,
  });
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
  const config = adminCollections[collection];
  if (!config) throw new HttpError(404, "NOT_FOUND", "接口不存在");
  const filters = adminListFilters(request);
  const listWhere = buildAdminWhere(config, filters, true);
  const countWhere = buildAdminWhere(config, filters, true);
  const summaryWhere = buildAdminWhere(config, filters, false);
  const [items, count, summaryRows] = await Promise.all([
    selectAdminRows(env, `${config.select} ${config.from} ${listWhere.sql} ${config.orderBy} LIMIT ? OFFSET ?`, [...listWhere.params, filters.pageSize, filters.offset]),
    selectAdminFirst<{ total: number }>(env, `SELECT COUNT(*) AS total ${config.from} ${countWhere.sql}`, countWhere.params),
    config.summaryColumn
      ? selectAdminRows<{ key: string | null; count: number }>(env, `SELECT ${config.summaryColumn} AS key, COUNT(*) AS count ${config.from} ${summaryWhere.sql} GROUP BY ${config.summaryColumn}`, summaryWhere.params)
      : Promise.resolve([]),
  ]);
  const summary: Record<string, number> = {};
  for (const row of summaryRows) summary[String(row.key ?? "UNKNOWN")] = Number(row.count ?? 0);
  return ok({ items, total: Number(count?.total ?? 0), page: filters.page, pageSize: filters.pageSize, summary });
}

type AdminListFilters = {
  page: number;
  pageSize: number;
  offset: number;
  q: string;
  status: string;
  fromMs: number | null;
  toMs: number | null;
};

type AdminCollectionConfig = {
  select: string;
  from: string;
  orderBy: string;
  searchColumns?: string[];
  statusColumn?: string;
  dateColumn?: string;
  summaryColumn?: string;
};

const adminCollections: Record<string, AdminCollectionConfig> = {
  users: {
    select: `SELECT u.id, u.email, u.role, u.status, u.student_id, u.real_name,
                    u.allow_auto_join_reservation, u.square_visibility, u.created_at, u.last_login_at,
                    c.credential_status, c.last_refresh_success_at, c.refresh_failure_count,
                    (SELECT COUNT(*) FROM reservation_tasks t WHERE t.owner_user_id = u.id OR t.requested_by_user_id = u.id) AS task_count,
                    (SELECT COUNT(*) FROM reservations r WHERE r.owner_user_id = u.id OR r.requested_by_user_id = u.id) AS reservation_count`,
    from: "FROM users u LEFT JOIN official_credentials c ON c.user_id = u.id",
    orderBy: "ORDER BY u.created_at DESC",
    searchColumns: ["u.id", "u.email", "u.student_id", "u.real_name"],
    statusColumn: "u.status",
    dateColumn: "u.created_at",
    summaryColumn: "u.status",
  },
  credentials: {
    select: `SELECT c.user_id, u.email, u.student_id, u.real_name, u.status AS user_status,
                    c.credential_status, c.access_token_expires_seconds, c.access_token_obtained_at,
                    c.token_version, c.last_refresh_attempt_at, c.last_refresh_success_at,
                    c.refresh_failure_count, c.last_error_code, c.last_error_message,
                    c.created_at, c.updated_at`,
    from: "FROM official_credentials c JOIN users u ON u.id = c.user_id",
    orderBy: "ORDER BY c.updated_at DESC",
    searchColumns: ["c.user_id", "u.email", "u.student_id", "u.real_name", "c.last_error_code"],
    statusColumn: "c.credential_status",
    dateColumn: "c.updated_at",
    summaryColumn: "c.credential_status",
  },
  tasks: {
    select: `SELECT t.id, t.owner_user_id, u.email AS owner_email, u.real_name AS owner_name,
                    u.student_id AS owner_student_id, t.requested_by_user_id, t.target_date,
                    t.start_time, t.end_time, t.use_description, t.status, t.attempt_count,
                    t.last_attempt_at, t.official_reservation_id, t.failure_code,
                    t.failure_message, t.created_at, t.updated_at,
                    (SELECT GROUP_CONCAT(room_name_snapshot, '、') FROM reservation_task_candidate_rooms r WHERE r.task_id = t.id ORDER BY priority) AS candidate_rooms,
                    (SELECT COUNT(*) FROM reservation_task_members m WHERE m.task_id = t.id) AS member_count`,
    from: "FROM reservation_tasks t JOIN users u ON u.id = t.owner_user_id",
    orderBy: "ORDER BY t.created_at DESC",
    searchColumns: ["t.id", "u.email", "u.real_name", "u.student_id", "t.official_reservation_id", "t.failure_code"],
    statusColumn: "t.status",
    dateColumn: "t.created_at",
    summaryColumn: "t.status",
  },
  reservations: {
    select: `SELECT r.id, r.task_id, r.owner_user_id, u.email AS owner_email,
                    u.real_name AS owner_name, r.requested_by_user_id, r.official_reservation_id,
                    r.room_id, r.room_name_snapshot, r.date, r.start_time, r.end_time,
                    r.submission_type, r.status, r.official_status, r.synced_at,
                    r.created_at, r.updated_at`,
    from: "FROM reservations r JOIN users u ON u.id = r.owner_user_id",
    orderBy: "ORDER BY r.created_at DESC",
    searchColumns: ["r.id", "r.official_reservation_id", "r.room_name_snapshot", "u.email", "u.real_name"],
    statusColumn: "r.status",
    dateColumn: "r.created_at",
    summaryColumn: "r.status",
  },
  invitations: {
    select: `SELECT i.id, i.task_id, i.inviter_user_id, inviter.email AS inviter_email,
                    i.invitee_user_id, invitee.email AS invitee_email, i.invitee_student_id,
                    i.invitee_real_name, i.status, i.approval_source, i.expires_at,
                    i.responded_at, i.created_at`,
    from: "FROM reservation_invitations i JOIN users inviter ON inviter.id = i.inviter_user_id LEFT JOIN users invitee ON invitee.id = i.invitee_user_id",
    orderBy: "ORDER BY i.created_at DESC",
    searchColumns: ["i.id", "i.task_id", "inviter.email", "invitee.email", "i.invitee_student_id", "i.invitee_real_name"],
    statusColumn: "i.status",
    dateColumn: "i.created_at",
    summaryColumn: "i.status",
  },
  teams: {
    select: `SELECT t.id, t.name, t.description, t.leader_user_id, u.email AS leader_email,
                    u.real_name AS leader_name, t.created_at,
                    (SELECT COUNT(*) + 1 FROM team_members m WHERE m.team_id = t.id) AS member_count`,
    from: "FROM teams t JOIN users u ON u.id = t.leader_user_id",
    orderBy: "ORDER BY t.created_at DESC",
    searchColumns: ["t.id", "t.name", "t.description", "u.email", "u.real_name"],
    dateColumn: "t.created_at",
  },
  "team-invitations": {
    select: `SELECT i.id, i.team_id, t.name AS team_name, i.inviter_user_id,
                    inviter.email AS inviter_email, i.invitee_user_id, invitee.email AS invitee_email,
                    i.status, i.expires_at, i.responded_at, i.created_at`,
    from: "FROM team_invitations i JOIN teams t ON t.id = i.team_id JOIN users inviter ON inviter.id = i.inviter_user_id JOIN users invitee ON invitee.id = i.invitee_user_id",
    orderBy: "ORDER BY i.created_at DESC",
    searchColumns: ["i.id", "t.name", "inviter.email", "invitee.email"],
    statusColumn: "i.status",
    dateColumn: "i.created_at",
    summaryColumn: "i.status",
  },
  "sign-tasks": {
    select: `SELECT s.id, s.reservation_id, r.official_reservation_id, r.room_name_snapshot,
                    r.date, r.start_time, r.end_time, u.email AS owner_email,
                    s.scheduled_at, s.status, s.attempt_count, NULL AS parameter_received_at, s.executed_at`,
    from: "FROM sign_tasks s JOIN reservations r ON r.id = s.reservation_id JOIN users u ON u.id = r.owner_user_id",
    orderBy: "ORDER BY s.scheduled_at DESC",
    searchColumns: ["s.id", "s.reservation_id", "r.official_reservation_id", "r.room_name_snapshot", "u.email"],
    statusColumn: "s.status",
    dateColumn: "s.scheduled_at",
    summaryColumn: "s.status",
  },
  "signout-tasks": {
    select: `SELECT s.id, s.reservation_id, s.official_reservation_id, r.room_name_snapshot,
                    r.date, r.start_time, r.end_time, u.email AS owner_email,
                    s.scheduled_at, s.status, s.attempt_count, s.executed_at`,
    from: "FROM signout_tasks s JOIN reservations r ON r.id = s.reservation_id JOIN users u ON u.id = r.owner_user_id",
    orderBy: "ORDER BY s.scheduled_at DESC",
    searchColumns: ["s.id", "s.reservation_id", "s.official_reservation_id", "r.room_name_snapshot", "u.email"],
    statusColumn: "s.status",
    dateColumn: "s.scheduled_at",
    summaryColumn: "s.status",
  },
  emails: {
    select: "SELECT id, recipient_email, template, dedupe_key, status, attempt_count, next_attempt_at, delivery_lock_until, last_error_message, created_at, sent_at",
    from: "FROM email_outbox",
    orderBy: "ORDER BY created_at DESC",
    searchColumns: ["id", "recipient_email", "template", "dedupe_key", "last_error_message"],
    statusColumn: "status",
    dateColumn: "created_at",
    summaryColumn: "status",
  },
  "audit-logs": {
    select: "SELECT id, actor_user_id, actor_type, action, target_type, target_id, result, metadata_redacted_json, created_at",
    from: "FROM audit_logs",
    orderBy: "ORDER BY created_at DESC",
    searchColumns: ["id", "actor_user_id", "action", "target_type", "target_id", "result"],
    statusColumn: "result",
    dateColumn: "created_at",
    summaryColumn: "result",
  },
  "gateway-jobs": {
    select: `SELECT j.id, j.kind, j.lane, j.owner_user_id, u.email AS owner_email,
                    j.status, j.priority, j.attempt_count, j.max_attempts, j.available_at,
                    j.error_code, j.error_message, j.created_at, j.started_at, j.finished_at, j.updated_at`,
    from: "FROM official_gateway_jobs j LEFT JOIN users u ON u.id = j.owner_user_id",
    orderBy: "ORDER BY j.created_at DESC",
    searchColumns: ["j.id", "j.kind", "j.lane", "u.email", "j.error_code", "j.error_message"],
    statusColumn: "j.status",
    dateColumn: "j.created_at",
    summaryColumn: "j.status",
  },
  "gateway-snapshots": {
    select: `SELECT s.cache_key, s.scope, s.owner_user_id, u.email AS owner_email,
                    s.kind, s.version, s.fresh_until, s.stale_until, s.refreshed_at,
                    s.refresh_job_id, s.last_error_code, s.last_error_message, s.created_at, s.updated_at`,
    from: "FROM official_gateway_snapshots s LEFT JOIN users u ON u.id = s.owner_user_id",
    orderBy: "ORDER BY s.updated_at DESC",
    searchColumns: ["s.cache_key", "s.kind", "u.email", "s.last_error_code", "s.last_error_message"],
    statusColumn: "s.kind",
    dateColumn: "s.updated_at",
    summaryColumn: "s.kind",
  },
};

function adminListFilters(request: Request): AdminListFilters {
  const params = new URL(request.url).searchParams;
  const page = boundedQueryInteger(params.get("page"), 1, 1, 100_000);
  const pageSize = boundedQueryInteger(params.get("pageSize"), 25, 1, 100);
  const fromMs = queryDateMs(params.get("from"), false);
  const toMs = queryDateMs(params.get("to"), true);
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    q: (params.get("q") ?? "").trim().slice(0, 100),
    status: (params.get("status") ?? "").trim().slice(0, 80),
    fromMs,
    toMs,
  };
}

function boundedQueryInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function queryDateMs(value: string | null, endOfDay: boolean): number | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, "INVALID_DATE", "日期格式错误");
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp)) throw new HttpError(400, "INVALID_DATE", "日期格式错误");
  return endOfDay ? timestamp + 24 * 60 * 60 * 1000 - 1 : timestamp;
}

function buildAdminWhere(config: AdminCollectionConfig, filters: AdminListFilters, includeStatus: boolean): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.q && config.searchColumns?.length) {
    const queryParts = config.searchColumns.map((column) => `LOWER(COALESCE(CAST(${column} AS TEXT), '')) LIKE ?`);
    conditions.push(`(${queryParts.join(" OR ")})`);
    params.push(...config.searchColumns.map(() => `%${filters.q.toLowerCase()}%`));
  }
  if (includeStatus && filters.status && config.statusColumn) {
    conditions.push(`${config.statusColumn} = ?`);
    params.push(filters.status);
  }
  if (filters.fromMs !== null && config.dateColumn) {
    conditions.push(`${config.dateColumn} >= ?`);
    params.push(filters.fromMs);
  }
  if (filters.toMs !== null && config.dateColumn) {
    conditions.push(`${config.dateColumn} <= ?`);
    params.push(filters.toMs);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

async function selectAdminRows<T = Record<string, unknown>>(env: AppEnv, sql: string, params: unknown[]): Promise<T[]> {
  const statement = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  return (await statement.all<T>()).results;
}

async function selectAdminFirst<T = Record<string, unknown>>(env: AppEnv, sql: string, params: unknown[]): Promise<T | null> {
  const statement = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  return statement.first<T>();
}

export async function adminCancelTask(env: AppEnv, request: Request, taskId: string): Promise<Response> {
  const admin = await requireAdmin(env, request);
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE reservation_tasks
        SET status = 'CANCELLED', updated_at = ?
      WHERE id = ? AND status IN ('DRAFT', 'WAITING_WINDOW', 'WAITING_MEMBERS', 'READY')`,
  ).bind(now, taskId).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "TASK_STATUS_CONFLICT", "当前任务状态不允许取消");
  await releaseReservationQuota(env, "TASK", taskId);
  await audit(env.DB, { actorUserId: admin.id, actorType: "ADMIN", action: "ADMIN_TASK_CANCELLED", targetType: "RESERVATION_TASK", targetId: taskId, result: "SUCCESS" });
  return ok({ id: taskId, status: "CANCELLED" });
}

export async function adminRequireCredentialRebind(env: AppEnv, request: Request, userId: string): Promise<Response> {
  const admin = await requireAdmin(env, request);
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ? AND status <> 'DELETED'").bind(userId).first<{ id: string; email: string }>();
  if (!user) throw new HttpError(404, "NOT_FOUND", "用户不存在");
  const result = await env.DB.prepare(
    `UPDATE official_credentials
        SET credential_status = 'REAUTH_REQUIRED', refresh_lock_until = NULL, updated_at = ?
      WHERE user_id = ? AND credential_status <> 'DISABLED'`,
  ).bind(Date.now(), userId).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "CREDENTIAL_STATUS_CONFLICT", "当前凭证状态无法要求重新绑定");
  await queueMail(env, user.email, "OFFICIAL_REAUTH_REQUIRED", {}, { dedupeKey: `admin-reauth:${userId}` });
  await audit(env.DB, { actorUserId: admin.id, actorType: "ADMIN", action: "ADMIN_CREDENTIAL_REBIND_REQUIRED", targetType: "USER", targetId: userId, result: "SUCCESS" });
  return ok({ id: userId, credentialStatus: "REAUTH_REQUIRED" });
}

export async function adminRetryEmail(env: AppEnv, request: Request, emailId: string): Promise<Response> {
  const admin = await requireAdmin(env, request);
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE email_outbox
        SET status = 'PENDING', next_attempt_at = ?, delivery_lock_until = NULL,
            last_error_message = NULL
      WHERE id = ?
        AND (status = 'FAILED' OR (status = 'PENDING' AND delivery_lock_until IS NOT NULL AND delivery_lock_until < ?))`,
  ).bind(now, emailId, now).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "EMAIL_STATUS_CONFLICT", "当前邮件状态不允许重试");
  await audit(env.DB, { actorUserId: admin.id, actorType: "ADMIN", action: "ADMIN_EMAIL_RETRIED", targetType: "EMAIL", targetId: emailId, result: "SUCCESS" });
  return ok({ id: emailId, status: "PENDING" });
}

export async function adminCancelGatewayJob(env: AppEnv, request: Request, jobId: string): Promise<Response> {
  const admin = await requireAdmin(env, request);
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE official_gateway_jobs
        SET status = 'CANCELLED', locked_at = NULL, lease_until = NULL,
            error_code = 'ADMIN_CANCELLED', error_message = '管理员已取消排队任务',
            finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'QUEUED'`,
  ).bind(now, now, jobId).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "GATEWAY_JOB_STATUS_CONFLICT", "只有排队中的访问任务可以取消");
  await audit(env.DB, { actorUserId: admin.id, actorType: "ADMIN", action: "ADMIN_GATEWAY_JOB_CANCELLED", targetType: "GATEWAY_JOB", targetId: jobId, result: "SUCCESS" });
  return ok({ id: jobId, status: "CANCELLED" });
}

export async function adminRetryGatewayJob(env: AppEnv, request: Request, jobId: string): Promise<Response> {
  const admin = await requireAdmin(env, request);
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE official_gateway_jobs
        SET status = 'QUEUED', locked_at = NULL, lease_until = NULL,
            available_at = ?, attempt_count = 0, result_json = NULL,
            error_code = NULL, error_message = NULL, started_at = NULL,
            finished_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'FAILED' AND lane = 'READ'`,
  ).bind(now, now, jobId).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "GATEWAY_JOB_STATUS_CONFLICT", "只有失败的只读访问任务可以重试");
  await audit(env.DB, { actorUserId: admin.id, actorType: "ADMIN", action: "ADMIN_GATEWAY_JOB_RETRIED", targetType: "GATEWAY_JOB", targetId: jobId, result: "SUCCESS" });
  return ok({ id: jobId, status: "QUEUED" });
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
