import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/config";
import { deleteTeam, leaveTeam, removeTeamMember, respondTeamInvitation } from "../src/api/app";
import { sha256 } from "../src/lib/crypto";
import { applyMigrations } from "../src/node/migrations";
import { openSqliteDatabase } from "../src/node/sqlite";

const LEADER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "33333333-3333-4333-8333-333333333333";

async function testContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "njau-libyy-team-mail-"));
  const db = openSqliteDatabase(path.join(dir, "test.sqlite"));
  applyMigrations(db, path.resolve("migrations"));
  const env = {
    DB: db,
    SESSION_SECRET: "session-secret",
    TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    APP_BASE_URL: "http://localhost",
  } as unknown as AppEnv;
  const now = Date.now();

  for (const user of [
    { id: LEADER_ID, email: "leader@example.com", studentId: "9233000001", name: "队长" },
    { id: MEMBER_ID, email: "member@example.com", studentId: "9233000002", name: "成员" },
  ]) {
    await db.prepare(
      `INSERT INTO users (id, email, email_verified_at, password_hash, student_id, real_name, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', ?, ?, ?, ?)`,
    ).bind(user.id, user.email, now, user.studentId, user.name, now, now).run();
    await db.prepare(
      `INSERT INTO official_credentials
        (id, user_id, access_token_ciphertext, reflush_token_ciphertext, access_token_expires_seconds,
         access_token_obtained_at, credential_status, created_at, updated_at)
       VALUES (?, ?, 'access', 'refresh', 7200, ?, 'ACTIVE', ?, ?)`,
    ).bind(`credential-${user.id}`, user.id, now, now, now).run();
    await db.prepare(
      `INSERT INTO official_login_credentials (user_id, student_id, password_ciphertext, created_at, updated_at)
       VALUES (?, ?, 'password', ?, ?)`,
    ).bind(user.id, user.studentId, now, now).run();
  }

  async function requestFor(userId: string, url: string, body?: Record<string, unknown>): Promise<Request> {
    const token = `token-${userId}`;
    const tokenHash = await sha256(`${env.SESSION_SECRET}:${token}`);
    await db.prepare(
      `INSERT OR IGNORE INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(`session-${userId}`, userId, tokenHash, now + 60_000, now).run();
    return new Request(url, {
      method: body ? "POST" : "DELETE",
      headers: { cookie: `libyy_session=${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  return { db, env, now, requestFor };
}

describe("team operation mail", () => {
  it("notifies the affected side for invitation responses and membership changes", async () => {
    const { db, env, now, requestFor } = await testContext();
    await db.prepare("INSERT INTO teams (id, leader_user_id, name, description, created_at, updated_at) VALUES (?, ?, '测试小队', '', ?, ?)")
      .bind(TEAM_ID, LEADER_ID, now, now).run();

    const acceptedId = "44444444-4444-4444-8444-444444444444";
    const rejectedId = "55555555-5555-4555-8555-555555555555";
    for (const [id, token] of [[acceptedId, "accept-token"], [rejectedId, "reject-token"]] as const) {
      await db.prepare(
        `INSERT INTO team_invitations
          (id, team_id, inviter_user_id, invitee_user_id, status, action_token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      ).bind(id, TEAM_ID, LEADER_ID, MEMBER_ID, await sha256(`${env.SESSION_SECRET}:${token}`), now + 60_000, now).run();
    }

    await respondTeamInvitation(env, await requestFor(MEMBER_ID, `http://localhost/api/v1/team-invitations/${acceptedId}/respond`, { action: "accept" }), acceptedId);
    await respondTeamInvitation(env, await requestFor(MEMBER_ID, `http://localhost/api/v1/team-invitations/${rejectedId}/respond`, { action: "reject" }), rejectedId);
    await leaveTeam(env, await requestFor(MEMBER_ID, `http://localhost/api/v1/teams/${TEAM_ID}/members/me`), TEAM_ID);

    await db.prepare("INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)").bind(TEAM_ID, MEMBER_ID, now).run();
    await removeTeamMember(env, await requestFor(LEADER_ID, `http://localhost/api/v1/teams/${TEAM_ID}/members/${MEMBER_ID}`), TEAM_ID, MEMBER_ID);

    await db.prepare("INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)").bind(TEAM_ID, MEMBER_ID, now).run();
    await deleteTeam(env, await requestFor(LEADER_ID, `http://localhost/api/v1/teams/${TEAM_ID}`), TEAM_ID);

    const rows = await db.prepare("SELECT recipient_email, template FROM email_outbox ORDER BY created_at, template").all<{ recipient_email: string; template: string }>();
    expect(rows.results).toEqual(expect.arrayContaining([
      { recipient_email: "leader@example.com", template: "TEAM_INVITATION_ACCEPTED" },
      { recipient_email: "leader@example.com", template: "TEAM_INVITATION_REJECTED" },
      { recipient_email: "leader@example.com", template: "TEAM_MEMBER_LEFT" },
      { recipient_email: "member@example.com", template: "TEAM_MEMBER_REMOVED" },
      { recipient_email: "member@example.com", template: "TEAM_DISBANDED" },
    ]));
    expect(rows.results).toHaveLength(5);
  });
});
