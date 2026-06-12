import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/config";
import { queueMail } from "../src/lib/mail";
import { applyMigrations } from "../src/node/migrations";
import { openSqliteDatabase } from "../src/node/sqlite";

function testEnv(): AppEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "njau-libyy-mail-"));
  const db = openSqliteDatabase(path.join(dir, "test.sqlite"));
  applyMigrations(db, path.resolve("migrations"));
  return {
    DB: db,
    TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  } as unknown as AppEnv;
}

describe("mail outbox", () => {
  it("queues one row per dedupe key while allowing distinct recipients", async () => {
    const env = testEnv();
    await expect(queueMail(env, "one@example.com", "TEST_EMAIL", {}, { dedupeKey: "event:user-one" })).resolves.toBe(true);
    await expect(queueMail(env, "one@example.com", "TEST_EMAIL", {}, { dedupeKey: "event:user-one" })).resolves.toBe(false);
    await expect(queueMail(env, "two@example.com", "TEST_EMAIL", {}, { dedupeKey: "event:user-two" })).resolves.toBe(true);

    const rows = await env.DB.prepare("SELECT recipient_email, dedupe_key FROM email_outbox ORDER BY recipient_email").all();
    expect(rows.results).toEqual([
      { recipient_email: "one@example.com", dedupe_key: "event:user-one" },
      { recipient_email: "two@example.com", dedupe_key: "event:user-two" },
    ]);
  });

  it("normalizes queued workflow notifications to one mail per reservation user", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "njau-libyy-mail-migration-"));
    const migrationsDir = path.join(dir, "migrations");
    fs.mkdirSync(migrationsDir);
    for (const name of fs.readdirSync(path.resolve("migrations")).filter((name) => name.endsWith(".sql") && name < "0011_")) {
      fs.copyFileSync(path.resolve("migrations", name), path.join(migrationsDir, name));
    }
    const db = openSqliteDatabase(path.join(dir, "test.sqlite"));
    applyMigrations(db, migrationsDir);
    const now = Date.now();
    const userId = "11111111-1111-4111-8111-111111111111";
    const firstWorkflow = "22222222-2222-4222-8222-222222222222";
    const secondWorkflow = "33333333-3333-4333-8333-333333333333";
    await db.prepare(
      "INSERT INTO users (id, email, email_verified_at, password_hash, created_at, updated_at) VALUES (?, 'user@example.com', ?, 'hash', ?, ?)",
    ).bind(userId, now, now, now).run();
    for (const [workflowId, officialId] of [[firstWorkflow, "official-1"], [secondWorkflow, "official-2"]]) {
      await db.prepare(
        `INSERT INTO sign_workflows
          (id, requested_by_user_id, anchor_user_id, official_reservation_id, room_id, room_name_snapshot,
           date, start_time, end_time, sign_advance_minutes, signout_advance_minutes, sign_scheduled_at,
           signout_scheduled_at, status, signout_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 2, '7E08', '2026-06-12', '09:00', '10:00', 15, 10, ?, ?, 'ACTIVE', 'PENDING', ?, ?)`,
      ).bind(workflowId, userId, userId, officialId, now, now, now, now).run();
    }
    await db.prepare(
      `INSERT INTO email_outbox
        (id, recipient_email, template, payload_json, status, attempt_count, created_at, sent_at, dedupe_key)
       VALUES ('sent-mail', 'user@example.com', 'AUTO_SIGN_SUCCESS', 'payload', 'SENT', 1, ?, ?, ?)`,
    ).bind(now, now, `auto-sign:${firstWorkflow}:success:${userId}`).run();
    await db.prepare(
      `INSERT INTO email_outbox
        (id, recipient_email, template, payload_json, status, attempt_count, next_attempt_at, created_at, dedupe_key)
       VALUES ('pending-mail', 'user@example.com', 'AUTO_SIGN_SUCCESS', 'payload', 'PENDING', 0, ?, ?, ?)`,
    ).bind(now, now + 1, `auto-sign:${secondWorkflow}:success:${userId}`).run();

    fs.copyFileSync(path.resolve("migrations", "0011_normalize_sign_mail_dedupe.sql"), path.join(migrationsDir, "0011_normalize_sign_mail_dedupe.sql"));
    applyMigrations(db, migrationsDir);

    const rows = await db.prepare("SELECT id, status, dedupe_key, last_error_message FROM email_outbox ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: "pending-mail", status: "FAILED", dedupe_key: null, last_error_message: "DUPLICATE_NOTIFICATION_SUPPRESSED" },
      { id: "sent-mail", status: "SENT", dedupe_key: `auto-sign:2:2026-06-12:09:00:10:00:success:${userId}`, last_error_message: null },
    ]);
  });
});
