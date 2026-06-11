import type { AppEnv } from "../config";
import type { AppPreparedStatement } from "../db/types";
import { getAccessToken, getOfficialReservationProfile } from "./credentials";
import { HttpError } from "./http";
import { fetchOfficialReservationHistory, type OfficialReservationRecord } from "./official";

export type ReservationUser = {
  id: string;
  student_id: string | null;
  real_name: string | null;
};

type OfficialSnapshotMember = {
  userId?: unknown;
  realName?: unknown;
  userType?: unknown;
  status?: unknown;
  swipe?: unknown;
};

export type MemberSnapshot = {
  userId: string;
  realName: string;
  userType: number | null;
  status: number | null;
  swipe: number | null;
  localUserId: string | null;
};

export type SignDevice = {
  roomId: string;
  systemMac: string;
};

export type SignWorkflowInput = {
  reservationId?: string | null;
  requestedByUserId: string;
  anchorUserId: string;
  officialReservationId: string;
  roomId: number;
  roomName: string;
  date: string;
  startTime: string;
  endTime: string;
  startTimestamp: number;
  endTimestamp: number;
  minSignTime?: number | null;
  signAdvanceMinutes?: number;
  signoutAdvanceMinutes?: number;
  participantUserIds: string[];
  replaceExisting?: boolean;
};

export function shanghaiParts(timestamp: number): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

export function localReservationStatus(officialStatus: number): string {
  return ({
    12: "WAITING_MEMBER_CONFIRMATION",
    21: "SCHEDULED",
    31: "SIGNED_IN",
    51: "SIGNED_OUT",
    53: "SIGNED_OUT",
    61: "CANCELLED",
    63: "CANCELLED",
  } as Record<number, string>)[officialStatus] ?? `OFFICIAL_${officialStatus}`;
}

export function reservationStatusLabel(status: string, officialStatus?: number | null): string {
  if (typeof officialStatus === "number") {
    const official = ({
      12: "待成员确认",
      21: "待签到",
      31: "已签到",
      51: "已签退",
      53: "系统签退",
      61: "已取消",
      63: "系统取消",
    } as Record<number, string>)[officialStatus];
    if (official) return official;
  }
  return ({
    WAITING_MEMBER_CONFIRMATION: "待成员确认",
    SUBMITTED_UNVERIFIED: "同步中",
    SUCCESS: "预约成功",
    SCHEDULED: "待签到",
    SIGNED_IN: "已签到",
    SIGNED_OUT: "已签退",
    CANCELLED: "已取消",
  } as Record<string, string>)[status] ?? status;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function localUsersByStudentId(env: AppEnv, studentIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(studentIds)].filter(Boolean);
  if (!unique.length) return new Map();
  const placeholders = unique.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, student_id FROM users WHERE student_id IN (${placeholders})`,
  ).bind(...unique).all<{ id: string; student_id: string }>();
  return new Map(rows.results.map((row) => [row.student_id, row.id]));
}

export async function officialMemberSnapshot(env: AppEnv, record: OfficialReservationRecord): Promise<MemberSnapshot[]> {
  const rawMembers = Array.isArray(record.members) ? record.members : [];
  const parsed = rawMembers
    .filter((value): value is OfficialSnapshotMember => Boolean(value) && typeof value === "object")
    .map((member) => ({
      userId: typeof member.userId === "string" ? member.userId : "",
      realName: typeof member.realName === "string" ? member.realName : "",
      userType: nullableNumber(member.userType),
      status: nullableNumber(member.status),
      swipe: nullableNumber(member.swipe),
    }))
    .filter((member) => member.userId);

  const members = parsed.length
    ? parsed
    : [{
      userId: record.userId,
      realName: typeof record.userName === "string" ? record.userName : "",
      userType: 1,
      status: null,
      swipe: record.reservationStatus === 31 || record.reservationStatus === 51 || record.reservationStatus === 53 ? 1 : 0,
    }];

  const localIds = await localUsersByStudentId(env, members.map((member) => member.userId));
  return members.map((member) => ({
    ...member,
    localUserId: localIds.get(member.userId) ?? null,
  }));
}

export async function createSignWorkflow(env: AppEnv, input: SignWorkflowInput): Promise<string> {
  if (!input.participantUserIds.length) throw new HttpError(400, "PARTICIPANTS_REQUIRED", "签到任务至少需要一位成员");
  const existing = input.reservationId
    ? await env.DB.prepare("SELECT id FROM sign_workflows WHERE reservation_id = ?").bind(input.reservationId).first<{ id: string }>()
    : null;
  if (existing && !input.replaceExisting) return existing.id;

  const signAdvance = Math.min(60, Math.max(0, Math.trunc(input.signAdvanceMinutes ?? 15)));
  const signoutAdvance = Math.min(60, Math.max(0, Math.trunc(input.signoutAdvanceMinutes ?? 10)));
  const requestedSignAt = input.startTimestamp - signAdvance * 60_000;
  const signScheduledAt = Math.max(requestedSignAt, input.minSignTime ?? requestedSignAt);
  const signoutScheduledAt = input.endTimestamp - signoutAdvance * 60_000;
  const workflowId = existing?.id ?? crypto.randomUUID();
  const now = Date.now();
  const participantIds = [...new Set(input.participantUserIds)];
  const statements: AppPreparedStatement[] = existing ? [
    env.DB.prepare(
      `UPDATE sign_workflows
          SET requested_by_user_id = ?, anchor_user_id = ?, official_reservation_id = ?, room_id = ?,
              room_name_snapshot = ?, date = ?, start_time = ?, end_time = ?, sign_advance_minutes = ?,
              signout_advance_minutes = ?, sign_scheduled_at = ?, signout_scheduled_at = ?, status = 'ACTIVE',
              signout_status = 'PENDING', signout_user_id = NULL, signout_executed_at = NULL,
              failure_code = NULL, failure_message = NULL, updated_at = ?
        WHERE id = ?`,
    ).bind(
      input.requestedByUserId,
      input.anchorUserId,
      input.officialReservationId,
      input.roomId,
      input.roomName,
      input.date,
      input.startTime,
      input.endTime,
      signAdvance,
      signoutAdvance,
      signScheduledAt,
      signoutScheduledAt,
      now,
      workflowId,
    ),
    env.DB.prepare("DELETE FROM sign_workflow_participants WHERE workflow_id = ?").bind(workflowId),
  ] : [
    env.DB.prepare(
      `INSERT INTO sign_workflows
        (id, reservation_id, requested_by_user_id, anchor_user_id, official_reservation_id,
         room_id, room_name_snapshot, date, start_time, end_time, sign_advance_minutes,
         signout_advance_minutes, sign_scheduled_at, signout_scheduled_at, status,
         signout_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'PENDING', ?, ?)`,
    ).bind(
      workflowId,
      input.reservationId ?? null,
      input.requestedByUserId,
      input.anchorUserId,
      input.officialReservationId,
      input.roomId,
      input.roomName,
      input.date,
      input.startTime,
      input.endTime,
      signAdvance,
      signoutAdvance,
      signScheduledAt,
      signoutScheduledAt,
      now,
      now,
    ),
  ];
  participantIds.forEach((userId, index) => {
    statements.push(env.DB.prepare(
      `INSERT INTO sign_workflow_participants
        (workflow_id, user_id, participant_order, sign_status, updated_at)
       VALUES (?, ?, ?, 'PENDING', ?)`,
    ).bind(workflowId, userId, index + 1, now));
  });
  await env.DB.batch(statements);
  return workflowId;
}

export async function ensureReservationTasks(env: AppEnv, reservationId: string, record: OfficialReservationRecord): Promise<void> {
  if (![21, 31].includes(record.reservationStatus)) return;
  const reservation = await env.DB.prepare(
    `SELECT owner_user_id, COALESCE(requested_by_user_id, owner_user_id) AS requested_by_user_id,
            room_name_snapshot, date, start_time, end_time, member_snapshot_json
       FROM reservations WHERE id = ?`,
  ).bind(reservationId).first<{
    owner_user_id: string;
    requested_by_user_id: string;
    room_name_snapshot: string;
    date: string;
    start_time: string;
    end_time: string;
    member_snapshot_json: string;
  }>();
  if (!reservation) return;
  let members: MemberSnapshot[] = [];
  try {
    const parsed = JSON.parse(reservation.member_snapshot_json) as unknown;
    if (Array.isArray(parsed)) members = parsed as MemberSnapshot[];
  } catch {
    members = [];
  }
  await createSignWorkflow(env, {
    reservationId,
    requestedByUserId: reservation.requested_by_user_id,
    anchorUserId: reservation.owner_user_id,
    officialReservationId: String(record.id),
    roomId: record.roomId,
    roomName: record.roomName ?? reservation.room_name_snapshot,
    date: reservation.date,
    startTime: reservation.start_time,
    endTime: reservation.end_time,
    startTimestamp: record.startTime,
    endTimestamp: record.endTime,
    minSignTime: record.minSignTime,
    participantUserIds: [
      reservation.owner_user_id,
      ...members.map((member) => member.localUserId).filter((id): id is string => Boolean(id)),
    ],
  });
}

export async function syncOfficialReservationHistory(env: AppEnv, user: ReservationUser): Promise<OfficialReservationRecord[]> {
  const token = await getAccessToken(env, user.id);
  const profile = await getOfficialReservationProfile(env, user.id, token);
  const records = await fetchOfficialReservationHistory(env, token, profile.studentId);
  const now = Date.now();

  for (const record of records) {
    const parts = shanghaiParts(record.startTime);
    const end = shanghaiParts(record.endTime);
    const local = await env.DB.prepare(
      "SELECT id FROM reservations WHERE owner_user_id = ? AND official_reservation_id = ?",
    ).bind(user.id, String(record.id)).first<{ id: string }>();
    const reservationId = local?.id ?? crypto.randomUUID();
    const snapshot = JSON.stringify(await officialMemberSnapshot(env, record));

    if (local) {
      await env.DB.prepare(
        `UPDATE reservations SET room_id = ?, room_name_snapshot = ?, date = ?, start_time = ?, end_time = ?,
          member_snapshot_json = ?, status = ?, official_status = ?, synced_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        record.roomId,
        record.roomName ?? `房间 ${record.roomId}`,
        parts.date,
        parts.time,
        end.time,
        snapshot,
        localReservationStatus(record.reservationStatus),
        record.reservationStatus,
        now,
        now,
        reservationId,
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO reservations
          (id, owner_user_id, official_reservation_id, room_id, room_name_snapshot, date, start_time, end_time,
           member_snapshot_json, submission_type, status, official_response_json_redacted, official_status, synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, '{"syncedFromOfficial":true}', ?, ?, ?, ?)`,
      ).bind(
        reservationId,
        user.id,
        String(record.id),
        record.roomId,
        record.roomName ?? `房间 ${record.roomId}`,
        parts.date,
        parts.time,
        end.time,
        snapshot,
        localReservationStatus(record.reservationStatus),
        record.reservationStatus,
        now,
        now,
        now,
      ).run();
    }

    await ensureReservationTasks(env, reservationId, record);
    if (record.reservationStatus === 31) {
      await env.DB.prepare("UPDATE sign_tasks SET status = 'SUCCESS', executed_at = COALESCE(executed_at, ?) WHERE reservation_id = ? AND status <> 'SUCCESS'")
        .bind(record.signInTime ?? now, reservationId).run();
    }
    if (record.reservationStatus === 51 || record.reservationStatus === 53) {
      await env.DB.prepare("UPDATE signout_tasks SET status = 'SUCCESS', executed_at = COALESCE(executed_at, ?) WHERE reservation_id = ? AND status <> 'SUCCESS'")
        .bind(record.signOutTime ?? now, reservationId).run();
    }
    if (record.reservationStatus === 61 || record.reservationStatus === 63) {
      await env.DB.batch([
        env.DB.prepare("UPDATE sign_tasks SET status = 'DISABLED' WHERE reservation_id = ? AND status <> 'SUCCESS'").bind(reservationId),
        env.DB.prepare("UPDATE signout_tasks SET status = 'DISABLED' WHERE reservation_id = ? AND status <> 'SUCCESS'").bind(reservationId),
      ]);
    }
  }
  return records;
}

export async function findOfficialRecord(
  env: AppEnv,
  ownerUserId: string,
  officialReservationId: string,
): Promise<{ token: string; studentId: string; record: OfficialReservationRecord | null }> {
  const token = await getAccessToken(env, ownerUserId);
  const profile = await getOfficialReservationProfile(env, ownerUserId, token);
  const record = (await fetchOfficialReservationHistory(env, token, profile.studentId))
    .find((item) => String(item.id) === officialReservationId) ?? null;
  return { token, studentId: profile.studentId, record };
}

export function resolveSignDevice(env: AppEnv, roomId: number | string): SignDevice {
  const normalizedRoomId = String(roomId);
  const mapping = parseSignDeviceMap(env.SIGN_ROOM_SYSTEM_MAC_MAP);
  const systemMac = mapping[normalizedRoomId];
  if (systemMac) return { roomId: normalizedRoomId, systemMac };
  throw new HttpError(503, "SIGN_DEVICE_NOT_CONFIGURED_FOR_ROOM", "当前房间尚未配置签到设备映射");
}

export function parseSignDeviceMap(value: string | undefined): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value?.trim() || "{}");
  } catch {
    throw new HttpError(503, "SIGN_ROOM_SYSTEM_MAC_MAP_INVALID", "签到房间设备映射配置格式错误");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(503, "SIGN_ROOM_SYSTEM_MAC_MAP_INVALID", "签到房间设备映射配置格式错误");
  }
  const result: Record<string, string> = {};
  const usedMacs = new Set<string>();
  for (const [roomId, rawMac] of Object.entries(parsed)) {
    if (!/^\d+$/.test(roomId) || typeof rawMac !== "string" || !rawMac.trim()) {
      throw new HttpError(503, "SIGN_ROOM_SYSTEM_MAC_MAP_INVALID", "签到房间设备映射包含无效值");
    }
    const systemMac = rawMac.trim();
    if (usedMacs.has(systemMac)) {
      throw new HttpError(503, "SIGN_ROOM_SYSTEM_MAC_DUPLICATED", "不同房间不能复用同一个签到设备 MAC");
    }
    usedMacs.add(systemMac);
    result[roomId] = systemMac;
  }
  return result;
}

export function assertCompleteSignDeviceMap(value: string | undefined): Record<string, string> {
  const mapping = parseSignDeviceMap(value);
  const missing = Array.from({ length: 26 }, (_, index) => String(index + 2)).filter((roomId) => !mapping[roomId]);
  if (missing.length) {
    throw new HttpError(503, "SIGN_ROOM_SYSTEM_MAC_MAP_INCOMPLETE", `签到房间设备映射缺少房间：${missing.join(", ")}`);
  }
  return mapping;
}
