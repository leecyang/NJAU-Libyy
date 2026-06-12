import type { AppEnv } from "../config";
import type { AppDatabase, AppPreparedStatement } from "../db/types";
import { HttpError } from "./http";

export type ReservationQuota = {
  date: string;
  used: number;
  remaining: number;
  limit: 2;
};

export type UserMetrics = {
  userId: string;
  totalScore: number | null;
  scoreRefreshedAt: number | null;
  scoreStatus: "FRESH" | "STALE" | "EXPIRED" | "MISS";
  reservationQuota: ReservationQuota[];
};

export type QuotaSourceType = "TASK" | "RESERVATION" | "MANUAL";

export function shanghaiDateAt(offset = 0, now = new Date()): string {
  const base = new Date(now.valueOf());
  base.setUTCDate(base.getUTCDate() + offset);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(base);
}

export function metricDates(now = new Date()): string[] {
  return [0, 1, 2, 3].map((offset) => shanghaiDateAt(offset, now));
}

export function requestedMetricDates(request: Request, fallback = metricDates()): string[] {
  const values = new URL(request.url).searchParams.getAll("date");
  const dates = [...new Set(values.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))];
  return dates.length ? dates.slice(0, 8) : fallback;
}

export function userScoreSnapshotKey(userId: string): string {
  return `user:${userId}:score`;
}

export async function reservationQuotas(
  db: AppDatabase,
  userIds: string[],
  dates = metricDates(),
): Promise<Map<string, ReservationQuota[]>> {
  const uniqueUsers = [...new Set(userIds)].filter(Boolean);
  const result = new Map<string, ReservationQuota[]>();
  for (const userId of uniqueUsers) {
    result.set(userId, dates.map((date) => ({ date, used: 0, remaining: 2, limit: 2 })));
  }
  if (!uniqueUsers.length || !dates.length) return result;

  const userPlaceholders = uniqueUsers.map(() => "?").join(",");
  const datePlaceholders = dates.map(() => "?").join(",");
  const rows = await db.prepare(
    `SELECT user_id, reservation_date, COUNT(*) AS used
       FROM reservation_quota_claims
      WHERE user_id IN (${userPlaceholders}) AND reservation_date IN (${datePlaceholders})
      GROUP BY user_id, reservation_date`,
  ).bind(...uniqueUsers, ...dates).all<{ user_id: string; reservation_date: string; used: number }>();
  for (const row of rows.results) {
    const quotas = result.get(row.user_id);
    const quota = quotas?.find((item) => item.date === row.reservation_date);
    if (!quota) continue;
    quota.used = Math.min(2, Number(row.used));
    quota.remaining = Math.max(0, 2 - quota.used);
  }
  return result;
}

export async function readUserMetrics(env: AppEnv, userIds: string[], dates = metricDates()): Promise<Map<string, UserMetrics>> {
  const uniqueUsers = [...new Set(userIds)].filter(Boolean);
  const quotas = await reservationQuotas(env.DB, uniqueUsers, dates);
  const metrics = new Map<string, UserMetrics>();
  for (const userId of uniqueUsers) {
    const snapshot = env.OFFICIAL_GATEWAY
      ? await env.OFFICIAL_GATEWAY.readSnapshot<{ totalScore: number }>(userScoreSnapshotKey(userId))
      : null;
    metrics.set(userId, {
      userId,
      totalScore: snapshot?.value.totalScore ?? null,
      scoreRefreshedAt: snapshot?.refreshedAt ?? null,
      scoreStatus: snapshot?.freshness ?? "MISS",
      reservationQuota: quotas.get(userId) ?? dates.map((date) => ({ date, used: 0, remaining: 2, limit: 2 })),
    });
  }
  return metrics;
}

function quotaInsert(db: AppDatabase, userId: string, date: string, sourceType: QuotaSourceType, sourceId: string, now: number): AppPreparedStatement {
  return db.prepare(
    `INSERT INTO reservation_quota_claims
      (id, user_id, reservation_date, slot, source_type, source_id, created_at, updated_at)
     VALUES (?, ?, ?, (
       SELECT COALESCE(MIN(candidate.slot), 3)
         FROM (SELECT 1 AS slot UNION ALL SELECT 2 AS slot) candidate
        WHERE NOT EXISTS (
          SELECT 1 FROM reservation_quota_claims existing
           WHERE existing.user_id = ? AND existing.reservation_date = ? AND existing.slot = candidate.slot
        )
     ), ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), userId, date, userId, date, sourceType, sourceId, now, now);
}

export async function claimReservationQuota(
  env: AppEnv,
  userIds: string[],
  date: string,
  sourceType: QuotaSourceType,
  sourceId: string,
): Promise<void> {
  const uniqueUsers = [...new Set(userIds)].filter(Boolean);
  if (!uniqueUsers.length) throw new HttpError(400, "PARTICIPANTS_REQUIRED", "预约至少需要一位成员");
  const existing = await env.DB.prepare(
    `SELECT user_id FROM reservation_quota_claims
      WHERE reservation_date = ? AND source_type = ? AND source_id = ?`,
  ).bind(date, sourceType, sourceId).all<{ user_id: string }>();
  const claimed = new Set(existing.results.map((row) => row.user_id));
  const pending = uniqueUsers.filter((userId) => !claimed.has(userId));
  if (!pending.length) return;

  const now = Date.now();
  try {
    const results = await env.DB.batch(pending.map((userId) => quotaInsert(env.DB, userId, date, sourceType, sourceId, now)));
    if (results.some((result) => result.meta.changes !== 1)) throw new Error("quota slot unavailable");
  } catch {
    throw new HttpError(409, "DAILY_RESERVATION_LIMIT", "所选成员中有人当日已达到 2 次预约上限");
  }
}

export async function releaseReservationQuota(env: AppEnv, sourceType: QuotaSourceType, sourceId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM reservation_quota_claims WHERE source_type = ? AND source_id = ?")
    .bind(sourceType, sourceId).run();
}

export async function moveReservationQuota(
  env: AppEnv,
  fromType: QuotaSourceType,
  fromId: string,
  toType: QuotaSourceType,
  toId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE reservation_quota_claims SET source_type = ?, source_id = ?, updated_at = ?
      WHERE source_type = ? AND source_id = ?`,
  ).bind(toType, toId, Date.now(), fromType, fromId).run();
}

export function canonicalReservationSource(input: {
  roomId: number;
  date: string;
  startTime: string;
  endTime: string;
  studentIds: string[];
}): string {
  return [input.roomId, input.date, input.startTime, input.endTime, [...new Set(input.studentIds)].sort().join(",")].join(":");
}
