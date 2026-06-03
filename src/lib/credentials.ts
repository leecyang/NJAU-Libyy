import type { AppEnv } from "../config";
import type { User } from "./auth";
import { audit } from "./audit";
import { decryptSecret, encryptSecret } from "./crypto";
import { HttpError } from "./http";
import { queueMail } from "./mail";
import { fetchOfficialIdentity, refreshOfficialToken } from "./official";

type Credential = {
  id: string;
  user_id: string;
  access_token_ciphertext: string;
  reflush_token_ciphertext: string;
  access_token_expires_seconds: number;
  access_token_obtained_at: number;
  token_version: number;
  credential_status: string;
  refresh_lock_until: number | null;
};

const LOCK_MS = 60_000;

async function persistTokens(
  env: AppEnv,
  userId: string,
  accessToken: string,
  reflushToken: string,
  expires: number,
  now: number,
  expectedLockUntil?: number,
): Promise<void> {
  const [accessCiphertext, reflushCiphertext] = await Promise.all([
    encryptSecret(accessToken, env.TOKEN_ENCRYPTION_KEY),
    encryptSecret(reflushToken, env.TOKEN_ENCRYPTION_KEY),
  ]);
  const existing = await env.DB.prepare("SELECT id FROM official_credentials WHERE user_id = ?").bind(userId).first<{ id: string }>();

  if (existing) {
    const update = await env.DB.prepare(
      `UPDATE official_credentials
          SET access_token_ciphertext = ?, reflush_token_ciphertext = ?,
              access_token_expires_seconds = ?, access_token_obtained_at = ?,
              token_version = token_version + 1, credential_status = 'ACTIVE',
              refresh_lock_until = NULL, last_refresh_attempt_at = ?,
              last_refresh_success_at = ?, refresh_failure_count = 0,
              last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE user_id = ?${expectedLockUntil === undefined ? "" : " AND refresh_lock_until = ?"}`,
    ).bind(accessCiphertext, reflushCiphertext, expires, now, now, now, now, userId, ...(expectedLockUntil === undefined ? [] : [expectedLockUntil])).run();
    if (update.meta.changes !== 1) throw new Error("Credential refresh lock lost before token persistence");
    return;
  }

  await env.DB.prepare(
    `INSERT INTO official_credentials
      (id, user_id, access_token_ciphertext, reflush_token_ciphertext,
       access_token_expires_seconds, access_token_obtained_at, token_version,
       credential_status, last_refresh_attempt_at, last_refresh_success_at,
       refresh_failure_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'ACTIVE', ?, ?, 0, ?, ?)`,
  ).bind(crypto.randomUUID(), userId, accessCiphertext, reflushCiphertext, expires, now, now, now, now, now).run();
}

export async function bindCredential(env: AppEnv, user: User, submittedReflushToken: string): Promise<void> {
  const now = Date.now();
  const refreshed = await refreshOfficialToken(env, submittedReflushToken);
  const identity = await fetchOfficialIdentity(env, refreshed.accessToken);
  const conflictingUser = await env.DB.prepare(
    "SELECT id FROM users WHERE student_id = ? AND id <> ?",
  ).bind(identity.userId, user.id).first<{ id: string }>();

  if (conflictingUser) {
    // The submitted token has already rolled. Preserve its successor for the existing owner.
    await persistTokens(env, conflictingUser.id, refreshed.accessToken, refreshed.reflushToken, refreshed.expires, now);
    await audit(env.DB, {
      actorUserId: user.id,
      actorType: "USER",
      action: "CREDENTIAL_BIND_CONFLICT",
      targetType: "USER",
      targetId: conflictingUser.id,
      result: "REJECTED_TOKENS_PRESERVED",
      metadata: { studentIdConflict: true },
    });
    throw new HttpError(409, "STUDENT_ID_ALREADY_BOUND", "该官方身份已绑定其他账号，新凭证已安全归还原绑定账号");
  }

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET student_id = ?, real_name = ?, official_user_internal_id = ?, official_mobile_ciphertext = ?, updated_at = ? WHERE id = ?",
    ).bind(
      identity.userId,
      identity.realName,
      identity.id ?? null,
      identity.mobile ? await encryptSecret(identity.mobile, env.TOKEN_ENCRYPTION_KEY) : null,
      now,
      user.id,
    ),
  ]);
  await persistTokens(env, user.id, refreshed.accessToken, refreshed.reflushToken, refreshed.expires, now);
  await audit(env.DB, {
    actorUserId: user.id,
    actorType: "USER",
    action: "CREDENTIAL_BOUND",
    targetType: "CREDENTIAL",
    targetId: user.id,
    result: "SUCCESS",
  });
}

export async function getOfficialReservationProfile(
  env: AppEnv,
  userId: string,
  accessToken: string,
): Promise<{ studentId: string; realName: string; mobile: string }> {
  const stored = await env.DB.prepare(
    "SELECT student_id, real_name, official_mobile_ciphertext FROM users WHERE id = ?",
  ).bind(userId).first<{ student_id: string | null; real_name: string | null; official_mobile_ciphertext: string | null }>();
  if (!stored) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
  if (stored.student_id && stored.real_name && stored.official_mobile_ciphertext) {
    return {
      studentId: stored.student_id,
      realName: stored.real_name,
      mobile: await decryptSecret(stored.official_mobile_ciphertext, env.TOKEN_ENCRYPTION_KEY),
    };
  }

  const identity = await fetchOfficialIdentity(env, accessToken);
  if (!identity.mobile) throw new HttpError(409, "OFFICIAL_PROFILE_INCOMPLETE", "官方身份缺少预约所需手机号，请重新绑定凭证");
  await env.DB.prepare(
    "UPDATE users SET student_id = ?, real_name = ?, official_user_internal_id = ?, official_mobile_ciphertext = ?, updated_at = ? WHERE id = ?",
  ).bind(
    identity.userId,
    identity.realName,
    identity.id ?? null,
    await encryptSecret(identity.mobile, env.TOKEN_ENCRYPTION_KEY),
    Date.now(),
    userId,
  ).run();
  return { studentId: identity.userId, realName: identity.realName, mobile: identity.mobile };
}

export async function credentialStatus(env: AppEnv, userId: string): Promise<Record<string, unknown>> {
  const credential = await env.DB.prepare(
    `SELECT credential_status, access_token_expires_seconds, access_token_obtained_at,
            token_version, last_refresh_success_at, refresh_failure_count,
            last_error_code, last_error_message
       FROM official_credentials WHERE user_id = ?`,
  ).bind(userId).first<Record<string, unknown>>();
  return credential ?? { credential_status: "UNBOUND" };
}

export async function getAccessToken(env: AppEnv, userId: string): Promise<string> {
  const credential = await env.DB.prepare(
    `SELECT id, user_id, access_token_ciphertext, reflush_token_ciphertext,
            access_token_expires_seconds, access_token_obtained_at, token_version,
            credential_status, refresh_lock_until
       FROM official_credentials WHERE user_id = ?`,
  ).bind(userId).first<Credential>();
  if (!credential) throw new HttpError(409, "CREDENTIAL_UNBOUND", "请先绑定官方凭证");
  if (credential.credential_status !== "ACTIVE") throw new HttpError(409, "CREDENTIAL_NOT_ACTIVE", "官方凭证当前不可用，请重新绑定");

  const expiresAt = credential.access_token_obtained_at + credential.access_token_expires_seconds * 1000;
  if (expiresAt - Date.now() < 15 * 60 * 1000) {
    await refreshCredential(env, userId, "BUSINESS_PRECHECK");
    return getAccessToken(env, userId);
  }
  return decryptSecret(credential.access_token_ciphertext, env.TOKEN_ENCRYPTION_KEY);
}

export async function refreshCredential(
  env: AppEnv,
  userId: string,
  source: "SCHEDULED" | "BUSINESS_PRECHECK" | "ADMIN",
): Promise<boolean> {
  const now = Date.now();
  const lockUntil = now + LOCK_MS;
  const lock = await env.DB.prepare(
    `UPDATE official_credentials
        SET refresh_lock_until = ?, credential_status = 'REFRESHING',
            last_refresh_attempt_at = ?, updated_at = ?
      WHERE user_id = ? AND credential_status IN ('ACTIVE', 'REFRESH_FAILED')
        AND (refresh_lock_until IS NULL OR refresh_lock_until < ?)`,
  ).bind(lockUntil, now, now, userId, now).run();
  if (lock.meta.changes !== 1) return false;

  try {
    const credential = await env.DB.prepare(
      "SELECT reflush_token_ciphertext FROM official_credentials WHERE user_id = ? AND refresh_lock_until = ?",
    ).bind(userId, lockUntil).first<{ reflush_token_ciphertext: string }>();
    if (!credential) throw new Error("Credential lock lost");
    const reflushToken = await decryptSecret(credential.reflush_token_ciphertext, env.TOKEN_ENCRYPTION_KEY);
    const refreshed = await refreshOfficialToken(env, reflushToken);
    await persistTokens(env, userId, refreshed.accessToken, refreshed.reflushToken, refreshed.expires, Date.now(), lockUntil);
    await audit(env.DB, {
      actorUserId: userId,
      actorType: source === "ADMIN" ? "ADMIN" : "SYSTEM",
      action: "CREDENTIAL_REFRESHED",
      targetType: "CREDENTIAL",
      targetId: userId,
      result: "SUCCESS",
      metadata: { source },
    });
    return true;
  } catch (error) {
    const reauth = error instanceof HttpError && error.code === "OFFICIAL_REAUTH_REQUIRED";
    if (reauth) {
      await env.DB.prepare("DELETE FROM official_credentials WHERE user_id = ? AND refresh_lock_until = ?").bind(userId, lockUntil).run();
    } else {
      await env.DB.prepare(
        `UPDATE official_credentials
            SET credential_status = 'REFRESH_FAILED', refresh_lock_until = NULL,
                refresh_failure_count = refresh_failure_count + 1,
                last_error_code = NULL, last_error_message = ?, updated_at = ?
          WHERE user_id = ? AND refresh_lock_until = ?`,
      ).bind("凭证刷新失败", Date.now(), userId, lockUntil).run();
    }
    await audit(env.DB, {
      actorUserId: userId,
      actorType: source === "ADMIN" ? "ADMIN" : "SYSTEM",
      action: "CREDENTIAL_REFRESHED",
      targetType: "CREDENTIAL",
      targetId: userId,
      result: "FAILED",
      metadata: { source, reauthRequired: reauth },
    });
    if (reauth) {
      const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
      if (user) await queueMail(env, user.email, "OFFICIAL_REAUTH_REQUIRED", {});
    }
    return false;
  }
}
