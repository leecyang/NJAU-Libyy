import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/config";
import { health } from "../src/api/app";
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
      SESSION_SECRET: "secret",
      PASSWORD_HASH_SECRET: "pepper",
      SIGN_LINK_BASE_URL: "https://libyy.njau.edu.cn/mStudent/codeSignIn/",
    } as AppEnv);
    const body = await response.json() as { ok: boolean; data: { database: string } };
    expect(body.ok).toBe(true);
    expect(body.data.database).toBe("ready");
  });
});

