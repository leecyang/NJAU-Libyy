import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/config";
import { health } from "../src/api/app";
import { credentialStatus } from "../src/lib/credentials";
import { applyMigrations } from "../src/node/migrations";
import { openSqliteDatabase } from "../src/node/sqlite";

function tempDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "njau-libyy-"));
  return {
    dir,
    db: openSqliteDatabase(path.join(dir, "test.sqlite")),
  };
}

describe("sqlite D1 compatibility layer", () => {
  it("supports bind/all/first/run/batch shapes used by the app", async () => {
    const { db } = tempDatabase();
    await db.prepare("CREATE TABLE demo (id TEXT PRIMARY KEY, value INTEGER)").run();
    await db.batch([
      db.prepare("INSERT INTO demo (id, value) VALUES (?, ?)").bind("a", 1),
      db.prepare("INSERT INTO demo (id, value) VALUES (?, ?)").bind("b", 2),
    ]);

    await expect(db.prepare("SELECT value FROM demo WHERE id = ?").bind("a").first<{ value: number }>())
      .resolves.toEqual({ value: 1 });
    await expect(db.prepare("SELECT id FROM demo ORDER BY id").all<{ id: string }>())
      .resolves.toEqual({ results: [{ id: "a" }, { id: "b" }] });
    await expect(db.prepare("UPDATE demo SET value = ? WHERE id = ?").bind(3, "b").run())
      .resolves.toEqual({ meta: { changes: 1 } });
  });

  it("applies migrations and serves the health contract", async () => {
    const { db } = tempDatabase();
    applyMigrations(db, path.resolve("migrations"));
    const response = await health({
      DB: db,
      ENVIRONMENT: "test",
      APP_VERSION: "test",
      LIBYY_APP_ID: "app",
      LIBYY_API_BASE_URL: "https://libyy.njau.edu.cn",
      APP_BASE_URL: "http://localhost",
      ALLOWED_EMAIL_DOMAINS: "qq.com",
      SMTP_HOST: "smtp.example",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USERNAME: "smtp-user",
      SMTP_FROM_ADDRESS: "noreply@example.com",
      SMTP_FROM_NAME: "NJAU Libyy",
      TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      CAS_CREDENTIAL_ENCRYPTION_KEY: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      SESSION_SECRET: "secret",
      PASSWORD_HASH_SECRET: "pepper",
      SIGN_LINK_BASE_URL: "https://libyy.njau.edu.cn/mStudent/codeSignIn/",
    } as AppEnv);
    const body = await response.json() as { ok: boolean; data: { database: string } };
    expect(body.ok).toBe(true);
    expect(body.data.database).toBe("ready");
    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('official_login_credentials', 'official_login_attempts') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results).toEqual([
      { name: "official_login_attempts" },
      { name: "official_login_credentials" },
    ]);
  });

  it("requires existing token users to add CAS credentials without deleting their token", async () => {
    const { db } = tempDatabase();
    applyMigrations(db, path.resolve("migrations"));
    const now = Date.now();
    await db.prepare(
      "INSERT INTO users (id, email, email_verified_at, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("11111111-1111-4111-8111-111111111111", "user@example.com", now, "hash", now, now).run();
    await db.prepare(
      `INSERT INTO official_credentials
        (id, user_id, access_token_ciphertext, reflush_token_ciphertext, access_token_expires_seconds,
         access_token_obtained_at, credential_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind("credential", "11111111-1111-4111-8111-111111111111", "access", "refresh", 7200, now, now, now).run();

    await expect(credentialStatus({ DB: db } as unknown as AppEnv, "11111111-1111-4111-8111-111111111111"))
      .resolves.toMatchObject({ credential_status: "ACTIVE", setup_required: true });

    await db.prepare(
      "INSERT INTO official_login_credentials (user_id, student_id, password_ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("11111111-1111-4111-8111-111111111111", "9233000000", "encrypted", now, now).run();
    await expect(credentialStatus({ DB: db } as unknown as AppEnv, "11111111-1111-4111-8111-111111111111"))
      .resolves.toMatchObject({ credential_status: "ACTIVE", setup_required: false, login_student_id: "9233000000" });
  });
});
