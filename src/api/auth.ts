import type { AppEnv } from "../config";
import { integerVar } from "../config";
import { createSession, hashClientIp, revokeSession } from "../lib/auth";
import { audit } from "../lib/audit";
import { hashPassword, randomDigits, sha256, verifyPassword } from "../lib/crypto";
import type { AppPreparedStatement } from "../db/types";
import { HttpError, ok, readJsonBody, requireString } from "../lib/http";
import { queueMail } from "../lib/mail";
import { assertAllowedEmail, assertPassword, normalizeEmail } from "../lib/validation";

type EmailBody = { email?: unknown };
type RegisterBody = { email?: unknown; code?: unknown; password?: unknown };
type LoginBody = { email?: unknown; password?: unknown };

async function codeHash(env: AppEnv, email: string, purpose: string, code: string): Promise<string> {
  return sha256(`${env.SESSION_SECRET}:${purpose}:${email}:${code}`);
}

async function sendCode(env: AppEnv, purpose: "REGISTER" | "RESET_PASSWORD", emailInput: unknown): Promise<Response> {
  const email = normalizeEmail(requireString(emailInput, "email", 254));
  assertAllowedEmail(email, env.ALLOWED_EMAIL_DOMAINS);
  const now = Date.now();
  const recent = await env.DB.prepare(
    "SELECT id FROM email_verification_codes WHERE email = ? AND purpose = ? AND created_at > ?",
  ).bind(email, purpose, now - 60_000).first();
  if (recent) throw new HttpError(429, "CODE_RATE_LIMITED", "验证码发送过于频繁，请稍后再试");

  if (purpose === "REGISTER") {
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) throw new HttpError(409, "EMAIL_ALREADY_REGISTERED", "该邮箱已注册");
  }

  const code = randomDigits();
  const ttlSeconds = integerVar(env, "VERIFICATION_CODE_TTL_SECONDS", 600);
  await env.DB.prepare(
    `INSERT INTO email_verification_codes (id, email, code_hash, purpose, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), email, await codeHash(env, email, purpose, code), purpose, now + ttlSeconds * 1000, now).run();
  await queueMail(env, email, purpose === "REGISTER" ? "REGISTER_CODE" : "RESET_PASSWORD_CODE", { code, expiresInSeconds: ttlSeconds });
  return ok({ queued: true });
}

async function findCode(env: AppEnv, email: string, purpose: string, code: string): Promise<{ id: string }> {
  const record = await env.DB.prepare(
    `SELECT id FROM email_verification_codes
      WHERE email = ? AND purpose = ? AND code_hash = ?
        AND used_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(email, purpose, await codeHash(env, email, purpose, code), Date.now()).first<{ id: string }>();
  if (!record) throw new HttpError(400, "INVALID_CODE", "验证码错误或已过期");
  return record;
}

function consumeCode(env: AppEnv, id: string, usedAt: number): AppPreparedStatement {
  return env.DB.prepare("UPDATE email_verification_codes SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(usedAt, id);
}

export async function sendRegisterCode(env: AppEnv, request: Request): Promise<Response> {
  const body = await readJsonBody<EmailBody>(request);
  return sendCode(env, "REGISTER", body.email);
}

export async function sendResetCode(env: AppEnv, request: Request): Promise<Response> {
  const body = await readJsonBody<EmailBody>(request);
  const email = normalizeEmail(requireString(body.email, "email", 254));
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND status = 'ACTIVE'").bind(email).first();
  if (!existing) return ok({ queued: true });
  return sendCode(env, "RESET_PASSWORD", email);
}

export async function register(env: AppEnv, request: Request): Promise<Response> {
  const body = await readJsonBody<RegisterBody>(request);
  const email = normalizeEmail(requireString(body.email, "email", 254));
  const code = requireString(body.code, "code", 12);
  const password = requireString(body.password, "password", 128);
  assertAllowedEmail(email, env.ALLOWED_EMAIL_DOMAINS);
  assertPassword(password);
  const verificationCode = await findCode(env, email, "REGISTER", code);
  const now = Date.now();
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password, env.PASSWORD_HASH_SECRET);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, email_verified_at, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, CASE WHEN NOT EXISTS (SELECT 1 FROM users) THEN 'ADMIN' ELSE 'USER' END, ?, ?)`,
      ).bind(userId, email, now, passwordHash, now, now),
      consumeCode(env, verificationCode.id, now),
    ]);
  } catch (error) {
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) throw new HttpError(409, "EMAIL_ALREADY_REGISTERED", "该邮箱已注册");
    throw error;
  }
  const registeredUser = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(userId).first<{ role: "USER" | "ADMIN" }>();
  await audit(env.DB, {
    actorUserId: userId,
    actorType: registeredUser?.role === "ADMIN" ? "ADMIN" : "USER",
    action: "ACCOUNT_REGISTERED",
    targetType: "USER",
    targetId: userId,
    result: "SUCCESS",
    metadata: { role: registeredUser?.role ?? "USER" },
  });
  return ok({ registered: true });
}

export async function login(env: AppEnv, request: Request): Promise<Response> {
  const body = await readJsonBody<LoginBody>(request);
  const email = normalizeEmail(requireString(body.email, "email", 254));
  const password = requireString(body.password, "password", 128);
  const ipHash = await hashClientIp(env, request);
  const since = Date.now() - 15 * 60 * 1000;
  const failed = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM login_attempts WHERE email = ? AND ip_hash = ? AND succeeded = 0 AND created_at > ?",
  ).bind(email, ipHash, since).first<{ count: number }>();
  if (Number(failed?.count ?? 0) >= 5) throw new HttpError(429, "LOGIN_RATE_LIMITED", "登录失败次数过多，请稍后再试");

  const user = await env.DB.prepare(
    "SELECT id, password_hash, status FROM users WHERE email = ?",
  ).bind(email).first<{ id: string; password_hash: string; status: string }>();
  const valid = user && await verifyPassword(password, user.password_hash, env.PASSWORD_HASH_SECRET);
  await env.DB.prepare(
    "INSERT INTO login_attempts (id, email, ip_hash, succeeded, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), email, ipHash, valid ? 1 : 0, Date.now()).run();
  if (!valid) throw new HttpError(401, "INVALID_CREDENTIALS", "邮箱或密码错误");
  if (user.status !== "ACTIVE") throw new HttpError(403, "ACCOUNT_DISABLED", "账号当前不可用");
  await env.DB.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(Date.now(), Date.now(), user.id).run();
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "ACCOUNT_LOGIN", targetType: "USER", targetId: user.id, result: "SUCCESS" });
  const response = ok({ loggedIn: true });
  response.headers.set("set-cookie", await createSession(env, request, user.id));
  return response;
}

export async function logout(env: AppEnv, request: Request): Promise<Response> {
  const response = ok({ loggedOut: true });
  response.headers.set("set-cookie", await revokeSession(env, request));
  return response;
}

export async function resetPassword(env: AppEnv, request: Request): Promise<Response> {
  const body = await readJsonBody<RegisterBody>(request);
  const email = normalizeEmail(requireString(body.email, "email", 254));
  const code = requireString(body.code, "code", 12);
  const password = requireString(body.password, "password", 128);
  assertPassword(password);
  const verificationCode = await findCode(env, email, "RESET_PASSWORD", code);
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND status = 'ACTIVE'").bind(email).first<{ id: string }>();
  if (!user) throw new HttpError(404, "ACCOUNT_NOT_FOUND", "账号不存在");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .bind(await hashPassword(password, env.PASSWORD_HASH_SECRET), now, user.id),
    env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, user.id),
    consumeCode(env, verificationCode.id, now),
  ]);
  await audit(env.DB, { actorUserId: user.id, actorType: "USER", action: "PASSWORD_RESET", targetType: "USER", targetId: user.id, result: "SUCCESS" });
  return ok({ reset: true });
}
