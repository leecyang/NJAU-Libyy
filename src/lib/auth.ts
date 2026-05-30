import type { AppEnv } from "../config";
import { randomToken, sha256 } from "./crypto";
import { HttpError } from "./http";

const SESSION_COOKIE = "libyy_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type User = {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "BANNED" | "DELETED";
  student_id: string | null;
  real_name: string | null;
  allow_auto_join_reservation: number;
  square_visibility: "VISIBLE" | "HIDDEN";
};

function parseCookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return result;
}

function cookieHeader(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export async function createSession(env: AppEnv, request: Request, userId: string): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256(`${env.SESSION_SECRET}:${token}`);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), userId, tokenHash, now + SESSION_TTL_MS, now).run();
  return cookieHeader(request, token, Math.floor(SESSION_TTL_MS / 1000));
}

export async function revokeSession(env: AppEnv, request: Request): Promise<string> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256(`${env.SESSION_SECRET}:${token}`);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(Date.now(), tokenHash)
      .run();
  }
  return cookieHeader(request, "", 0);
}

export async function currentUser(env: AppEnv, request: Request): Promise<User | null> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(`${env.SESSION_SECRET}:${token}`);
  const user = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.status, u.student_id, u.real_name,
            u.allow_auto_join_reservation, u.square_visibility
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
  ).bind(tokenHash, Date.now()).first<User>();
  return user ?? null;
}

export async function requireUser(env: AppEnv, request: Request): Promise<User> {
  const user = await currentUser(env, request);
  if (!user) throw new HttpError(401, "AUTH_REQUIRED", "请先登录");
  if (user.status !== "ACTIVE") throw new HttpError(403, "ACCOUNT_DISABLED", "账号当前不可用");
  return user;
}

export async function requireAdmin(env: AppEnv, request: Request): Promise<User> {
  const user = await requireUser(env, request);
  if (user.role !== "ADMIN") throw new HttpError(403, "ADMIN_REQUIRED", "需要管理员权限");
  return user;
}

export async function hashClientIp(env: AppEnv, request: Request): Promise<string> {
  return sha256(`${env.SESSION_SECRET}:${request.headers.get("cf-connecting-ip") ?? "local"}`);
}

