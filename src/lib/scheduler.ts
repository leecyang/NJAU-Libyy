import type { AppEnv } from "../config";
import { getAccessToken, refreshCredential } from "./credentials";
import { fetchOfficialRooms } from "./official";

export async function runScheduler(env: AppEnv): Promise<void> {
  const now = Date.now();
  await Promise.all([
    refreshDueCredentials(env, now),
    expireInvitations(env, now),
    prepareReservationTasks(env, now),
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
      WHERE status = 'WAITING_WINDOW' LIMIT 50`,
  ).all<{ id: string; owner_user_id: string; target_date: string }>();

  for (const task of rows.results) {
    try {
      const rooms = await fetchOfficialRooms(env, await getAccessToken(env, task.owner_user_id), task.target_date);
      if (rooms.length === 0) continue;
      const pending = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM reservation_invitations WHERE task_id = ? AND status = 'PENDING'",
      ).bind(task.id).first<{ count: number }>();
      const status = Number(pending?.count ?? 0) > 0 ? "WAITING_MEMBERS" : "READY";
      await env.DB.prepare("UPDATE reservation_tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'WAITING_WINDOW'")
        .bind(status, now, task.id)
        .run();
    } catch {
      // A later scan retries window discovery. Do not guess whether a network error means the window is closed.
    }
  }
}

