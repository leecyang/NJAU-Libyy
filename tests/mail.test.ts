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
});
