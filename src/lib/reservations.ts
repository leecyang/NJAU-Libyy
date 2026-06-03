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

export async function ensureReservationTasks(env: AppEnv, reservationId: string, record: OfficialReservationRecord): Promise<void> {
  const signout = await env.DB.prepare("SELECT id FROM signout_tasks WHERE reservation_id = ?").bind(reservationId).first();
  const sign = await env.DB.prepare("SELECT id FROM sign_tasks WHERE reservation_id = ?").bind(reservationId).first();
  const statements: AppPreparedStatement[] = [];
  if (!signout && (record.reservationStatus === 21 || record.reservationStatus === 31)) {
    statements.push(env.DB.prepare(
      `INSERT INTO signout_tasks (id, reservation_id, official_reservation_id, scheduled_at, status, attempt_count)
       VALUES (?, ?, ?, ?, 'PENDING', 0)`,
    ).bind(crypto.randomUUID(), reservationId, String(record.id), record.endTime - 10 * 60_000));
  }
  if (!sign && (record.reservationStatus === 21 || record.reservationStatus === 31)) {
    statements.push(env.DB.prepare(
      `INSERT INTO sign_tasks (id, reservation_id, scheduled_at, status, executed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      reservationId,
      record.minSignTime ?? record.startTime - 15 * 60_000,
      record.reservationStatus === 31 ? "SUCCESS" : "PENDING",
      record.reservationStatus === 31 ? record.signInTime ?? Date.now() : null,
    ));
  }
  if (statements.length) await env.DB.batch(statements);
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
  const mappingText = env.SIGN_ROOM_SYSTEM_MAC_MAP?.trim();
  if (mappingText) {
    try {
      const parsed = JSON.parse(mappingText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const systemMac = (parsed as Record<string, unknown>)[normalizedRoomId];
        if (typeof systemMac === "string" && systemMac.trim()) {
          return { roomId: normalizedRoomId, systemMac: systemMac.trim() };
        }
      }
    } catch {
      throw new HttpError(503, "SIGN_ROOM_SYSTEM_MAC_MAP_INVALID", "签到房间设备映射配置格式错误");
    }
  }

  const legacyRoomId = env.AUTHORIZED_SIGN_ROOM_ID?.trim();
  const legacySystemMac = env.AUTHORIZED_SIGN_SYSTEM_MAC?.trim();
  if (legacyRoomId === normalizedRoomId && legacySystemMac) {
    return { roomId: normalizedRoomId, systemMac: legacySystemMac };
  }

  throw new HttpError(503, "SIGN_DEVICE_NOT_CONFIGURED_FOR_ROOM", "当前房间尚未配置签到设备映射");
}
