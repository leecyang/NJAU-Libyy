import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/config";
import type { User } from "../src/lib/auth";
import { bindCredentialFromToken, getOfficialReservationProfile } from "../src/lib/credentials";
import { decryptSecret } from "../src/lib/crypto";
import { fetchOfficialIdentity, refreshOfficialToken, searchOfficialUsers } from "../src/lib/official";
import { applyMigrations } from "../src/node/migrations";
import { openSqliteDatabase } from "../src/node/sqlite";

vi.mock("../src/lib/official", () => ({
  fetchOfficialIdentity: vi.fn(),
  refreshOfficialToken: vi.fn(),
  searchOfficialUsers: vi.fn(),
}));

vi.mock("../src/lib/audit", () => ({ audit: vi.fn() }));

function testEnv(): AppEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "njau-libyy-credentials-"));
  const db = openSqliteDatabase(path.join(dir, "test.sqlite"));
  applyMigrations(db, path.resolve("migrations"));
  return {
    DB: db,
    TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  } as unknown as AppEnv;
}

function user(id: string): User {
  return {
    id,
    email: `${id}@example.com`,
    role: "USER",
    status: "ACTIVE",
    student_id: null,
    real_name: null,
    allow_auto_join_reservation: 0,
    square_visibility: "VISIBLE",
  };
}

describe("CAS token binding", () => {
  beforeEach(() => {
    vi.mocked(refreshOfficialToken).mockResolvedValue({ accessToken: "new-access", reflushToken: "new-refresh", expires: 7200 });
    vi.mocked(fetchOfficialIdentity).mockResolvedValue({ userId: "9233000000", realName: "Bound User", mobile: "13000000000" });
    vi.mocked(searchOfficialUsers).mockResolvedValue({ userId: "9233000000", realName: "Bound User" });
  });

  it("preserves a rolled token for the existing owner when a student id conflicts", async () => {
    const env = testEnv();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, email_verified_at, password_hash, student_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("22222222-2222-4222-8222-222222222222", "owner@example.com", now, "hash", "9233000000", now, now).run();
    await env.DB.prepare(
      "INSERT INTO users (id, email, email_verified_at, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("11111111-1111-4111-8111-111111111111", "submitter@example.com", now, "hash", now, now).run();

    await expect(bindCredentialFromToken(env, user("11111111-1111-4111-8111-111111111111"), "browser-refresh", "9233000000"))
      .rejects.toMatchObject({ code: "STUDENT_ID_ALREADY_BOUND" });

    const stored = await env.DB.prepare(
      "SELECT access_token_ciphertext, reflush_token_ciphertext FROM official_credentials WHERE user_id = ?",
    ).bind("22222222-2222-4222-8222-222222222222").first<{ access_token_ciphertext: string; reflush_token_ciphertext: string }>();
    expect(stored).not.toBeNull();
    await expect(decryptSecret(stored!.access_token_ciphertext, env.TOKEN_ENCRYPTION_KEY)).resolves.toBe("new-access");
    await expect(decryptSecret(stored!.reflush_token_ciphertext, env.TOKEN_ENCRYPTION_KEY)).resolves.toBe("new-refresh");
  });

  it("persists a simulated reservation mobile when official profiles omit it", async () => {
    const env = testEnv();
    const target = user("11111111-1111-4111-8111-111111111111");
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, email_verified_at, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(target.id, target.email, now, "hash", now, now).run();
    vi.mocked(fetchOfficialIdentity).mockResolvedValue({ userId: "9233000000", realName: "Bound User" });

    await bindCredentialFromToken(env, target, "browser-refresh", "9233000000");

    const profile = await getOfficialReservationProfile(env, target.id, "new-access");
    expect(profile.mobile).toMatch(/^199\d{8}$/);
    expect(searchOfficialUsers).toHaveBeenCalledWith(env, "new-access", "9233000000");
  });

  it("repairs existing bound users whose stored mobile is missing", async () => {
    const env = testEnv();
    const target = user("11111111-1111-4111-8111-111111111111");
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, email_verified_at, password_hash, student_id, real_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(target.id, target.email, now, "hash", "9233000000", "Bound User", now, now).run();
    vi.mocked(fetchOfficialIdentity).mockResolvedValue({ userId: "9233000000", realName: "Bound User" });

    const profile = await getOfficialReservationProfile(env, target.id, "existing-access");
    const stored = await env.DB.prepare("SELECT official_mobile_ciphertext FROM users WHERE id = ?")
      .bind(target.id).first<{ official_mobile_ciphertext: string }>();

    expect(profile.mobile).toMatch(/^199\d{8}$/);
    expect(stored?.official_mobile_ciphertext).toBeTruthy();
  });
});
