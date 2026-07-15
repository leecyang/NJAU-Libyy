import { createCipheriv, randomInt } from "node:crypto";
import type { AppEnv } from "../config";
import type { User } from "../lib/auth";
import { audit } from "../lib/audit";
import type { CasAttemptPublic, CasAttemptPurpose, CasAttemptStatus, CasAutomationAdapter } from "../lib/cas-types";
import { bindCredentialFromToken, bindCredentialFromTokens, blockCredentialRecovery, clearCredentialRecoveryBlock } from "../lib/credentials";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { queueMail } from "../lib/mail";
import type { OfficialRefreshResult } from "../lib/official";

type AttemptRow = {
  id: string;
  user_id: string;
  purpose: CasAttemptPurpose;
  student_id: string;
  pending_password_ciphertext: string | null;
  status: CasAttemptStatus;
  progress: string;
  sms_attempt_count: number;
  sms_expires_at: number | null;
  captcha_image: string | null;
  captcha_expires_at: number | null;
  error_code: string | null;
  error_message: string | null;
  expires_at: number;
};

type ActiveAttempt = {
  abortController: AbortController;
  abortReason?: CasAutomationError;
  smsResolver?: (code: string) => void;
  smsRejecter?: (error: unknown) => void;
  captchaResolver?: (code: string) => void;
  captchaRejecter?: (error: unknown) => void;
};

type LoginPage = {
  url: string;
  action: string;
  execution: string;
  pwdEncryptSalt: string;
  fields: Record<string, string>;
};

type ParsedForm = {
  attrs: Record<string, string>;
  inputs: Record<string, string>;
};

type ProtocolLoginResult =
  | { kind: "TOKENS"; tokens: OfficialRefreshResult }
  | { kind: "REFLUSH_TOKEN"; reflushToken: string };

type RequestOptions = RequestInit & {
  signal?: AbortSignal;
};

const ACTIVE_STATUSES = "('QUEUED', 'RUNNING', 'SMS_REQUIRED', 'CAPTCHA_REQUIRED')";
const ATTEMPT_TTL_MS = 10 * 60_000;
const SMS_TTL_MS = 5 * 60_000;
const CAPTCHA_TTL_MS = 3 * 60_000;
const MAX_CAPTCHA_ATTEMPTS = 3;
const CAPTCHA_RECOVERY_COOLDOWN_MS = 30 * 60_000;
const AUTH_BASE_URL = "https://authserver.njau.edu.cn";
const DEFAULT_AES_IV = "HDbk7NdBpFPpFrZR";
const RANDOM_PREFIX_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_SEC_CH_UA = "\"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\", \"Not-A.Brand\";v=\"99\"";
const MAX_REDIRECTS = 24;

class CasAutomationError extends Error {
  constructor(readonly code: string, message: string, readonly internalDetail?: string) {
    super(message);
  }
}

class ProtocolCookieJar {
  private readonly cookies = new Map<string, {
    name: string;
    value: string;
    domain: string;
    path: string;
    hostOnly: boolean;
    secure: boolean;
    expiresAt: number | null;
  }>();

  store(headers: Headers, requestUrl: URL): void {
    for (const raw of setCookieHeaders(headers)) {
      const cookie = parseSetCookie(raw, requestUrl);
      if (!cookie) continue;
      const key = `${cookie.domain}\t${cookie.path}\t${cookie.name}`;
      if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, cookie);
    }
  }

  header(url: URL): string {
    const now = Date.now();
    const pairs: string[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.secure && url.protocol !== "https:") continue;
      if (!domainMatches(url.hostname.toLowerCase(), cookie.domain, cookie.hostOnly)) continue;
      if (!pathMatches(url.pathname, cookie.path)) continue;
      pairs.push(`${cookie.name}=${cookie.value}`);
    }
    return pairs.join("; ");
  }

  size(): number {
    return this.cookies.size;
  }

  clear(): void {
    this.cookies.clear();
  }

  // Persist only the campus-auth cookies still valid — above all CASTGC, the CAS
  // "trusted device" ticket that lets a later attempt reuse SSO instead of a
  // fresh password login (which is what draws the risk-engine captcha).
  serialize(): string {
    const now = Date.now();
    const entries = [];
    for (const cookie of this.cookies.values()) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) continue;
      if (!cookie.domain.endsWith("njau.edu.cn")) continue;
      entries.push(cookie);
    }
    return JSON.stringify(entries);
  }

  restore(serialized: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const cookie = entry as Record<string, unknown>;
      if (typeof cookie.name !== "string" || typeof cookie.value !== "string") continue;
      if (typeof cookie.domain !== "string" || typeof cookie.path !== "string") continue;
      const expiresAt = typeof cookie.expiresAt === "number" ? cookie.expiresAt : null;
      if (expiresAt !== null && expiresAt <= now) continue;
      this.cookies.set(`${cookie.domain}\t${cookie.path}\t${cookie.name}`, {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        hostOnly: cookie.hostOnly === true,
        secure: cookie.secure === true,
        expiresAt,
      });
    }
  }
}

function publicAttempt(row: AttemptRow): CasAttemptPublic {
  return {
    attemptId: row.id,
    status: row.status,
    purpose: row.purpose,
    progress: row.progress,
    smsExpiresAt: row.sms_expires_at,
    captchaImage: row.captcha_image,
    captchaExpiresAt: row.captcha_expires_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function isStudentId(value: string): boolean {
  return /^[0-9A-Za-z]{4,32}$/.test(value);
}

function splitSetCookie(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.slice(index, index + 8).toLowerCase() === "expires=") inExpires = true;
    if (inExpires && value[index] === ";") inExpires = false;
    if (value[index] === "," && !inExpires && /\s*[^=;,\s]+=/.test(value.slice(index + 1))) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function setCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.();
  if (values?.length) return values;
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookie(combined) : [];
}

function defaultCookiePath(pathname: string): string {
  if (!pathname || !pathname.startsWith("/")) return "/";
  const index = pathname.lastIndexOf("/");
  return index <= 0 ? "/" : pathname.slice(0, index);
}

function parseSetCookie(raw: string, requestUrl: URL) {
  const parts = raw.split(";").map((part) => part.trim());
  const [nameValue, ...attrs] = parts;
  const separator = nameValue?.indexOf("=") ?? -1;
  if (!nameValue || separator <= 0) return null;
  const name = nameValue.slice(0, separator);
  const value = nameValue.slice(separator + 1);
  let domain = requestUrl.hostname.toLowerCase();
  let hostOnly = true;
  let path = defaultCookiePath(requestUrl.pathname);
  let secure = false;
  let expiresAt: number | null = null;

  for (const attr of attrs) {
    const [rawKey, ...rawValue] = attr.split("=");
    const key = rawKey?.toLowerCase();
    const attrValue = rawValue.join("=");
    if (key === "domain" && attrValue) {
      domain = attrValue.trim().replace(/^\./, "").toLowerCase();
      hostOnly = false;
    } else if (key === "path" && attrValue) {
      path = attrValue.startsWith("/") ? attrValue : "/";
    } else if (key === "secure") {
      secure = true;
    } else if (key === "expires" && attrValue) {
      const timestamp = Date.parse(attrValue);
      expiresAt = Number.isFinite(timestamp) ? timestamp : expiresAt;
    } else if (key === "max-age" && attrValue) {
      const seconds = Number(attrValue);
      if (Number.isFinite(seconds)) expiresAt = Date.now() + seconds * 1000;
    }
  }

  return { name, value, domain, path, hostOnly, secure, expiresAt };
}

function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  return hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  return pathname === cookiePath || pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function attrs(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;
  for (const match of value.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    result[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function parseForm(html: string, formId: string): ParsedForm | null {
  const formPattern = new RegExp(`<form\\b([^>]*)\\bid=["']${formId}["'][^>]*>[\\s\\S]*?<\\/form>`, "i");
  const formMatch = formPattern.exec(html);
  if (!formMatch?.[0]) return null;
  const startTag = /^<form\b([^>]*)>/i.exec(formMatch[0])?.[1] ?? "";
  const formAttrs = attrs(startTag);
  const inputs: Record<string, string> = {};
  for (const input of formMatch[0].matchAll(/<input\b([^>]*)>/gi)) {
    const inputAttrs = attrs(input[1] ?? "");
    const name = inputAttrs.name || inputAttrs.id;
    if (name) inputs[name] = inputAttrs.value ?? "";
  }
  return { attrs: formAttrs, inputs };
}

function extractLoginPage(html: string, url: string): LoginPage {
  const form = parseForm(html, "pwdFromId");
  if (!form) throw new CasAutomationError("CAS_FORM_ERROR", "统一认证登录表单加载异常");
  const execution = form.inputs.execution;
  const pwdEncryptSalt = form.inputs.pwdEncryptSalt;
  if (!execution || !pwdEncryptSalt) throw new CasAutomationError("CAS_FORM_ERROR", "统一认证登录表单缺少必要字段");
  const action = new URL(form.attrs.action || "/authserver/login", url).toString();
  return { url, action, execution, pwdEncryptSalt, fields: form.inputs };
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractErrorText(html: string): string {
  const patterns = [
    /id=["']showErrorTip["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    /class=["'][^"']*(?:error|auth_error|el-message)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    const text = stripTags(match?.[1] ?? "");
    if (text) return text;
  }
  return "";
}

function hasSliderChallenge(html: string): boolean {
  return /toSliderCaptcha\.htl|slider-captcha|sliderCaptchaDiv/i.test(html);
}

function hasSmsChallenge(html: string, url: string): boolean {
  return /dynamicCode|getDynamicCode|短信验证码|reAuthCheck|reAuthLoginView/i.test(html) || /reAuthCheck|reAuthLoginView/i.test(url);
}

function hasImageCaptcha(html: string, errorText = ""): boolean {
  if (hasSliderChallenge(html) || hasSmsChallenge(html, "")) return false;
  return /captchaDiv|getCaptcha\.htl/i.test(html) || /验证码|图形动态码/.test(errorText);
}

function isInvalidCredentialText(errorText: string): boolean {
  return /用户名|密码错误|账号|凭证错误/.test(errorText);
}

function randomPrefix(length = 64): string {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += RANDOM_PREFIX_CHARS[randomInt(RANDOM_PREFIX_CHARS.length)];
  }
  return result;
}

export function encryptCasPassword(password: string, pwdEncryptSalt: string): string {
  const key = Buffer.from(pwdEncryptSalt, "utf8");
  const iv = Buffer.from(DEFAULT_AES_IV, "utf8");
  if (key.byteLength !== 16) throw new CasAutomationError("CAS_FORM_ERROR", "统一认证加密参数异常");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(`${randomPrefix()}${password}`, "utf8"), cipher.final()]).toString("base64");
}

function serviceUrlFromLoginUrl(loginUrl: string): string {
  return new URL(loginUrl).searchParams.get("service") ?? "";
}

function withService(url: string, service: string): string {
  const target = new URL(url);
  if (service && !target.searchParams.has("service")) target.searchParams.set("service", service);
  return target.toString();
}

function formBody(fields: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => body.set(key, value));
  return body;
}

function parseJsonMaybe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function objectValues(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const object = value as Record<string, unknown>;
  return [
    object,
    ...["data", "result", "token", "tokenInfo", "oauth"].flatMap((key) => objectValues(object[key])),
  ];
}

function stringField(objects: Record<string, unknown>[], names: string[]): string | null {
  for (const object of objects) {
    for (const name of names) {
      const value = object[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function numberField(objects: Record<string, unknown>[], names: string[]): number | null {
  for (const object of objects) {
    for (const name of names) {
      const value = object[name];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
    }
  }
  return null;
}

function normalizeExpires(raw: number | null): number | null {
  if (!raw || !Number.isFinite(raw)) return null;
  if (raw > Date.now()) return Math.max(60, Math.trunc((raw - Date.now()) / 1000));
  if (raw > Date.now() / 1000) return Math.max(60, Math.trunc(raw - Date.now() / 1000));
  return Math.trunc(raw);
}

function tokenResultFromResponse(body: unknown): ProtocolLoginResult {
  const objects = objectValues(body);
  const accessToken = stringField(objects, ["accessToken", "access_token", "token"]);
  const reflushToken = stringField(objects, ["reflushToken", "refreshToken", "reflush_token", "refresh_token"]);
  const expires = normalizeExpires(numberField(objects, ["expires", "expiresIn", "expires_in", "expire", "expireIn", "expireTime"]));
  if (accessToken && reflushToken && expires) return { kind: "TOKENS", tokens: { accessToken, reflushToken, expires } };
  if (reflushToken) return { kind: "REFLUSH_TOKEN", reflushToken };
  throw new CasAutomationError("CAS_TOKEN_NOT_FOUND", "统一认证完成但未取得官方登录凭证");
}

function extractReauthParams(html: string): Record<string, unknown> {
  const match = /var\s+reAuthParams\s*=\s*(\{.*?\})\s*(?:;|\s*)/is.exec(html);
  if (!match?.[1]) return {};
  const parsed = parseJsonMaybe(match[1]);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function reauthCodeType(reauthType: string): string {
  return ({
    "3": "reAuthDynamicCodeType",
    "4": "reAuthWChatDynamicCodeType",
    "5": "reAuthCpdailyDynamicCodeType",
    "11": "reAuthEmailDynamicCodeType",
    "12": "reAuthDingTalkDynamicCodeType",
    "13": "reAuthWeLinkDynamicCodeType",
  } as Record<string, string>)[reauthType] ?? "reAuthDynamicCodeType";
}

function smsFormData(html: string): Record<string, string> {
  const reauth = extractReauthParams(html);
  if (Object.keys(reauth).length) {
    return {
      service: String(reauth.service ?? ""),
      reAuthType: String(reauth.reAuthType ?? ""),
      isMultifactor: String(reauth.isMultifactor ?? ""),
      password: "",
      dynamicCode: "",
      uuid: "",
      answer1: "",
      answer2: "",
      otpCode: "",
    };
  }
  return parseForm(html, "pwdFromId")?.inputs ?? parseForm(html, "phoneFromId")?.inputs ?? {};
}

export class CasLoginManager implements CasAutomationAdapter {
  private readonly queue: string[] = [];
  private readonly active = new Map<string, ActiveAttempt>();
  private running = 0;

  constructor(private readonly env: AppEnv) {}

  async initialize(): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare(
      `UPDATE official_login_attempts
          SET status = 'FAILED', progress = '服务重启，请重新发起认证',
              error_code = 'CAS_SERVICE_RESTARTED', error_message = '认证服务已重启',
              pending_password_ciphertext = NULL, sms_expires_at = NULL,
              captcha_image = NULL, captcha_expires_at = NULL, updated_at = ?
        WHERE status IN ('RUNNING', 'SMS_REQUIRED', 'CAPTCHA_REQUIRED')`,
    ).bind(now).run();
    await this.env.DB.prepare(
      `UPDATE official_login_attempts
          SET status = 'EXPIRED', progress = '认证任务已过期',
              error_code = 'CAS_ATTEMPT_EXPIRED', error_message = '认证任务已过期',
              pending_password_ciphertext = NULL, updated_at = ?
        WHERE status = 'QUEUED'`,
    ).bind(now).run();
  }

  async startAttempt(userId: string, studentId: string, password: string, purpose: CasAttemptPurpose): Promise<CasAttemptPublic> {
    if (!isStudentId(studentId)) throw new HttpError(400, "INVALID_STUDENT_ID", "学号格式错误");
    if (!password || password.length > 128) throw new HttpError(400, "INVALID_CAS_PASSWORD", "统一认证密码格式错误");
    const current = await this.env.DB.prepare(
      `SELECT id FROM official_login_attempts WHERE user_id = ? AND status IN ${ACTIVE_STATUSES} ORDER BY created_at DESC LIMIT 1`,
    ).bind(userId).first<{ id: string }>();
    if (current) throw new HttpError(409, "CAS_ATTEMPT_IN_PROGRESS", "已有统一认证任务正在进行");

    const now = Date.now();
    if (purpose !== "AUTO_RECOVERY") await clearCredentialRecoveryBlock(this.env, userId);
    const row: AttemptRow = {
      id: crypto.randomUUID(),
      user_id: userId,
      purpose,
      student_id: studentId,
      pending_password_ciphertext: await encryptSecret(password, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY),
      status: "QUEUED",
      progress: "等待启动统一认证协议登录",
      sms_attempt_count: 0,
      sms_expires_at: null,
      captcha_image: null,
      captcha_expires_at: null,
      error_code: null,
      error_message: null,
      expires_at: now + ATTEMPT_TTL_MS,
    };
    await this.env.DB.prepare(
      `INSERT INTO official_login_attempts
        (id, user_id, purpose, student_id, pending_password_ciphertext, status, progress,
         sms_attempt_count, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, 0, ?, ?, ?)`,
    ).bind(row.id, userId, purpose, studentId, row.pending_password_ciphertext, row.progress, row.expires_at, now, now).run();
    this.queue.push(row.id);
    this.pump();
    return publicAttempt(row);
  }

  async startRecovery(userId: string): Promise<CasAttemptPublic | null> {
    const active = await this.env.DB.prepare(
      `SELECT id, user_id, purpose, student_id, pending_password_ciphertext, status, progress,
              sms_attempt_count, sms_expires_at, captcha_image, captcha_expires_at, error_code, error_message, expires_at
         FROM official_login_attempts WHERE user_id = ? AND status IN ${ACTIVE_STATUSES}
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(userId).first<AttemptRow>();
    if (active) return publicAttempt(active);
    const stored = await this.env.DB.prepare(
      "SELECT student_id, password_ciphertext FROM official_login_credentials WHERE user_id = ?",
    ).bind(userId).first<{ student_id: string; password_ciphertext: string }>();
    if (!stored) return null;
    const password = await decryptSecret(stored.password_ciphertext, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY);
    try {
      return await this.startAttempt(userId, stored.student_id, password, "AUTO_RECOVERY");
    } catch (error) {
      if (error instanceof HttpError && error.code === "CAS_ATTEMPT_IN_PROGRESS") return null;
      throw error;
    }
  }

  async submitSms(userId: string, attemptId: string, code: string): Promise<CasAttemptPublic> {
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, "INVALID_SMS_CODE", "请输入 6 位短信验证码");
    const row = await this.attempt(attemptId);
    if (!row || row.user_id !== userId) throw new HttpError(404, "CAS_ATTEMPT_NOT_FOUND", "认证任务不存在");
    if (row.status !== "SMS_REQUIRED") throw new HttpError(409, "CAS_SMS_NOT_REQUIRED", "当前认证任务不需要短信验证码");
    if (!row.sms_expires_at || row.sms_expires_at <= Date.now()) throw new HttpError(410, "CAS_SMS_EXPIRED", "短信验证码提交已超时");
    if (row.sms_attempt_count >= 3) throw new HttpError(429, "CAS_SMS_ATTEMPTS_EXCEEDED", "短信验证码尝试次数已用完");
    const active = this.active.get(attemptId);
    if (!active?.smsResolver) throw new HttpError(409, "CAS_ATTEMPT_NOT_RUNNING", "认证任务已中断，请重新发起");
    await this.env.DB.prepare(
      `UPDATE official_login_attempts
          SET status = 'RUNNING', sms_attempt_count = sms_attempt_count + 1, progress = ?, sms_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'SMS_REQUIRED'`,
    ).bind("正在校验短信验证码", Date.now(), attemptId).run();
    const resolver = active.smsResolver;
    active.smsResolver = undefined;
    active.smsRejecter = undefined;
    resolver(code);
    return publicAttempt({
      ...row,
      status: "RUNNING",
      sms_attempt_count: row.sms_attempt_count + 1,
      sms_expires_at: null,
      progress: "正在校验短信验证码",
    });
  }

  async submitCaptcha(userId: string, attemptId: string, code: string): Promise<CasAttemptPublic> {
    if (!/^[0-9A-Za-z]{1,8}$/.test(code)) throw new HttpError(400, "INVALID_CAPTCHA_CODE", "请输入图形验证码");
    const row = await this.attempt(attemptId);
    if (!row || row.user_id !== userId) throw new HttpError(404, "CAS_ATTEMPT_NOT_FOUND", "认证任务不存在");
    if (row.status !== "CAPTCHA_REQUIRED") throw new HttpError(409, "CAS_CAPTCHA_NOT_REQUIRED", "当前认证任务不需要图形验证码");
    if (!row.captcha_expires_at || row.captcha_expires_at <= Date.now()) throw new HttpError(410, "CAS_CAPTCHA_EXPIRED", "图形验证码提交已超时");
    const active = this.active.get(attemptId);
    if (!active?.captchaResolver) throw new HttpError(409, "CAS_ATTEMPT_NOT_RUNNING", "认证任务已中断，请重新发起");
    await this.env.DB.prepare(
      `UPDATE official_login_attempts
          SET status = 'RUNNING', progress = ?, captcha_image = NULL, captcha_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'CAPTCHA_REQUIRED'`,
    ).bind("正在校验图形验证码", Date.now(), attemptId).run();
    const resolver = active.captchaResolver;
    active.captchaResolver = undefined;
    active.captchaRejecter = undefined;
    resolver(code);
    return publicAttempt({
      ...row,
      status: "RUNNING",
      captcha_image: null,
      captcha_expires_at: null,
      progress: "正在校验图形验证码",
    });
  }

  async removeUser(userId: string): Promise<void> {
    for (const [attemptId, active] of this.active) {
      const row = await this.attempt(attemptId);
      if (row?.user_id !== userId) continue;
      active.abortReason = new CasAutomationError("CAS_ATTEMPT_CANCELLED", "认证任务已取消");
      active.smsRejecter?.(active.abortReason);
      active.captchaRejecter?.(active.abortReason);
      active.abortController.abort();
      this.active.delete(attemptId);
    }
  }

  private maxConcurrency(): number {
    const value = Number(this.env.CAS_LOGIN_MAX_CONCURRENCY ?? this.env.PLAYWRIGHT_MAX_CONCURRENCY ?? "2");
    return Number.isInteger(value) && value > 0 ? Math.min(value, 8) : 2;
  }

  private loginTimeout(): number {
    const value = Number(this.env.CAS_LOGIN_TIMEOUT_MS ?? "180000");
    return Number.isFinite(value) && value >= 30_000 ? value : 180_000;
  }

  private pump(): void {
    while (this.running < this.maxConcurrency() && this.queue.length) {
      const attemptId = this.queue.shift()!;
      this.running += 1;
      void this.run(attemptId).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async attempt(attemptId: string): Promise<AttemptRow | null> {
    return this.env.DB.prepare(
      `SELECT id, user_id, purpose, student_id, pending_password_ciphertext, status, progress,
              sms_attempt_count, sms_expires_at, captcha_image, captcha_expires_at, error_code, error_message, expires_at
         FROM official_login_attempts WHERE id = ?`,
    ).bind(attemptId).first<AttemptRow>();
  }

  private async progress(attemptId: string, status: CasAttemptStatus, progress: string, smsExpiresAt: number | null = null): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE official_login_attempts SET status = ?, progress = ?, sms_expires_at = ?, updated_at = ? WHERE id = ?",
    ).bind(status, progress, smsExpiresAt, Date.now(), attemptId).run();
  }

  private async run(attemptId: string): Promise<void> {
    const active: ActiveAttempt = { abortController: new AbortController() };
    this.active.set(attemptId, active);
    const timeout = setTimeout(() => {
      active.abortReason = new CasAutomationError("CAS_ATTEMPT_TIMEOUT", "统一认证登录超时，请稍后重试");
      active.smsRejecter?.(active.abortReason);
      active.captchaRejecter?.(active.abortReason);
      active.abortController.abort();
    }, this.loginTimeout());
    try {
      await this.runAttempt(attemptId, active);
    } finally {
      clearTimeout(timeout);
      this.active.delete(attemptId);
    }
  }

  private async runAttempt(attemptId: string, active: ActiveAttempt): Promise<void> {
    let stage = "LOAD_ATTEMPT";
    try {
      const attempt = await this.attempt(attemptId);
      if (!attempt?.pending_password_ciphertext || attempt.expires_at <= Date.now()) throw new CasAutomationError("CAS_ATTEMPT_EXPIRED", "认证任务已过期");
      const password = await decryptSecret(attempt.pending_password_ciphertext, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY);
      await this.progress(attemptId, "RUNNING", "正在通过统一认证协议登录");
      stage = "CAS_PROTOCOL_LOGIN";
      const jar = new ProtocolCookieJar();
      await this.restoreCookieJar(jar, attempt.user_id);
      const result = await this.protocolLogin(attempt, password, active, jar);
      const user = await this.env.DB.prepare(
        `SELECT id, email, role, status, student_id, real_name, allow_auto_join_reservation, square_visibility,
                email_notifications_enabled
           FROM users WHERE id = ?`,
      ).bind(attempt.user_id).first<User>();
      if (!user) throw new CasAutomationError("ACCOUNT_NOT_FOUND", "账号不存在");
      stage = "BIND_CREDENTIAL";
      if (result.kind === "TOKENS") await bindCredentialFromTokens(this.env, user, result.tokens, attempt.student_id);
      else await bindCredentialFromToken(this.env, user, result.reflushToken, attempt.student_id);
      const passwordCiphertext = await encryptSecret(password, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY);
      const cookieJarCiphertext = await this.serializeCookieJar(jar);
      const now = Date.now();
      await this.env.DB.prepare(
        `INSERT INTO official_login_credentials
          (user_id, student_id, password_ciphertext, cookie_jar_ciphertext, last_login_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           student_id = excluded.student_id, password_ciphertext = excluded.password_ciphertext,
           cookie_jar_ciphertext = excluded.cookie_jar_ciphertext,
           last_login_at = excluded.last_login_at, last_error_code = NULL, updated_at = excluded.updated_at`,
      ).bind(attempt.user_id, attempt.student_id, passwordCiphertext, cookieJarCiphertext, now, now, now).run();
      await this.env.DB.prepare(
        `UPDATE official_login_attempts
            SET status = 'SUCCEEDED', progress = '统一认证完成', pending_password_ciphertext = NULL,
                sms_expires_at = NULL, captcha_image = NULL, captcha_expires_at = NULL,
                error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ?`,
      ).bind(now, attemptId).run();
      await audit(this.env.DB, { actorUserId: attempt.user_id, actorType: attempt.purpose === "AUTO_RECOVERY" ? "SYSTEM" : "USER", action: "CAS_LOGIN_SUCCEEDED", targetType: "CREDENTIAL", targetId: attempt.user_id, result: "SUCCESS", metadata: { purpose: attempt.purpose } });
    } catch (error) {
      const normalizedError = error instanceof CasAutomationError && error.code === "CAS_ATTEMPT_CANCELLED" && active.abortReason
        ? active.abortReason
        : error;
      const code = normalizedError instanceof CasAutomationError ? normalizedError.code : normalizedError instanceof HttpError ? normalizedError.code : "CAS_AUTOMATION_FAILED";
      const message = normalizedError instanceof CasAutomationError || normalizedError instanceof HttpError ? normalizedError.message : "统一认证协议登录失败，请稍后重试";
      const status: CasAttemptStatus = code === "CAS_ATTEMPT_EXPIRED" || code === "CAS_SMS_EXPIRED" ? "EXPIRED" : "FAILED";
      const failedAt = Date.now();
      await this.env.DB.prepare(
        `UPDATE official_login_attempts
            SET status = ?, progress = ?, pending_password_ciphertext = NULL, sms_expires_at = NULL,
                captcha_image = NULL, captcha_expires_at = NULL,
                error_code = ?, error_message = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'EXPIRED')`,
      ).bind(status, message, code, message, failedAt, attemptId).run();
      const failedAttempt = await this.attempt(attemptId);
      // Only the slider challenge is unsolvable through our human-in-the-loop flow,
      // so only it earns the recovery cooldown. A mistyped image code should let the
      // user retry immediately rather than freezing recovery for 30 minutes.
      if (code === "CAS_CAPTCHA_SLIDER" && failedAttempt) {
        await blockCredentialRecovery(this.env, failedAttempt.user_id, code, message, failedAt + CAPTCHA_RECOVERY_COOLDOWN_MS);
      }
      if (failedAttempt?.purpose === "AUTO_RECOVERY") {
        const user = await this.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(failedAttempt.user_id).first<{ email: string }>();
        if (user) await queueMail(this.env, user.email, "OFFICIAL_REAUTH_REQUIRED", {}, {
          dedupeKey: `official-reauth:${failedAttempt.id}:${failedAttempt.user_id}`,
        });
      }
      const detail = normalizedError instanceof CasAutomationError && normalizedError.internalDetail
        ? normalizedError.internalDetail
        : normalizedError instanceof Error ? normalizedError.message : String(normalizedError);
      const stack = normalizedError instanceof Error ? normalizedError.stack : undefined;
      console.error(JSON.stringify({ level: "error", event: "cas_login_failed", attemptId, stage, code, detail, stack }));
    }
  }

  private async restoreCookieJar(jar: ProtocolCookieJar, userId: string): Promise<void> {
    try {
      const row = await this.env.DB.prepare(
        "SELECT cookie_jar_ciphertext FROM official_login_credentials WHERE user_id = ?",
      ).bind(userId).first<{ cookie_jar_ciphertext: string | null }>();
      if (!row?.cookie_jar_ciphertext) return;
      jar.restore(await decryptSecret(row.cookie_jar_ciphertext, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY));
    } catch {
      // A corrupt or undecryptable saved jar must never block a fresh password login.
    }
  }

  private async serializeCookieJar(jar: ProtocolCookieJar): Promise<string | null> {
    const serialized = jar.serialize();
    if (serialized === "[]") return null;
    return encryptSecret(serialized, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY);
  }

  private browserHeaders(extra?: HeadersInit): Headers {
    const extraHeaders: Record<string, string> = {};
    new Headers(extra).forEach((value, key) => {
      extraHeaders[key] = value;
    });
    const headers = new Headers({
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "sec-ch-ua": DEFAULT_SEC_CH_UA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
      ...extraHeaders,
    });
    return headers;
  }

  private async request(jar: ProtocolCookieJar, url: URL | string, init: RequestOptions = {}): Promise<Response> {
    const target = new URL(url.toString());
    const headers = this.browserHeaders(init.headers);
    const cookie = jar.header(target);
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
    try {
      const response = await fetch(target, {
        ...init,
        headers,
        redirect: "manual",
        signal: init.signal,
      });
      jar.store(response.headers, new URL(response.url || target.toString()));
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new CasAutomationError("CAS_ATTEMPT_CANCELLED", "认证任务已取消");
      }
      throw new CasAutomationError("CAS_NETWORK_FAILED", "统一认证服务暂时不可用", error instanceof Error ? error.message : String(error));
    }
  }

  private async fetchFollow(jar: ProtocolCookieJar, inputUrl: URL | string, init: RequestOptions = {}): Promise<Response> {
    let url = new URL(inputUrl.toString());
    let method = init.method ?? "GET";
    let body = init.body;
    let headers = init.headers;
    let response = await this.request(jar, url, { ...init, method, body, headers });
    for (let redirect = 0; redirect < MAX_REDIRECTS && response.status >= 300 && response.status < 400; redirect += 1) {
      const location = response.headers.get("location");
      if (!location) return response;
      url = new URL(location, response.url || url.toString());
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
        const nextHeaders = new Headers(headers);
        nextHeaders.delete("content-type");
        headers = nextHeaders;
      }
      response = await this.request(jar, url, { ...init, method, body, headers });
    }
    return response;
  }

  private async protocolLogin(attempt: AttemptRow, password: string, active: ActiveAttempt, jar: ProtocolCookieJar): Promise<ProtocolLoginResult> {
    const reusedCookies = jar.size() > 0;
    const authorizeUrl = new URL("/api/oauth/v1/authorize", this.env.LIBYY_API_BASE_URL);
    authorizeUrl.searchParams.set("redirectURI", new URL("/", this.env.LIBYY_API_BASE_URL).toString());
    let response = await this.fetchFollow(jar, authorizeUrl, { signal: active.abortController.signal });
    let text = await response.text();
    let url = response.url;
    if (this.authorizationCode(url)) return this.exchangeAuthorizationCode(jar, this.authorizationCode(url)!, active, attempt.id, url);
    // The restored cookies (a stored CASTGC) did not grant SSO. A stale or foreign
    // device ticket is a common trigger for the risk-engine slider, and the user
    // prefers a clean SMS/password login over being stuck on it — so drop the saved
    // cookies and reload a fresh, unauthenticated session before entering the password.
    if (reusedCookies) {
      jar.clear();
      response = await this.fetchFollow(jar, authorizeUrl, { signal: active.abortController.signal });
      text = await response.text();
      url = response.url;
      if (this.authorizationCode(url)) return this.exchangeAuthorizationCode(jar, this.authorizationCode(url)!, active, attempt.id, url);
    }
    if (!url.includes("authserver.njau.edu.cn")) {
      throw new CasAutomationError("CAS_LOGIN_PAGE_NOT_FOUND", "未能进入统一认证登录页");
    }
    // Do NOT pre-abort on slider markup: the CAS login page ships the slider div in
    // its template (hidden until the risk engine enforces it), so matching raw markup
    // here falsely fails every login before the password is even tried. Submit the
    // password and let the actual response route to SMS / image captcha / success;
    // a genuinely enforced slider is reported only as a last resort in passwordLogin.
    const loginPage = extractLoginPage(text, url);
    return this.passwordLogin(jar, loginPage, attempt, password, active);
  }

  private async passwordLogin(
    jar: ProtocolCookieJar,
    initialPage: LoginPage,
    attempt: AttemptRow,
    password: string,
    active: ActiveAttempt,
  ): Promise<ProtocolLoginResult> {
    let page = initialPage;
    let captcha = "";
    for (let round = 0; round < MAX_CAPTCHA_ATTEMPTS; round += 1) {
      const response = await this.submitPassword(jar, page, attempt.student_id, password, captcha, active);
      const authCode = this.authorizationCode(response.url);
      if (authCode) return this.exchangeAuthorizationCode(jar, authCode, active, attempt.id, response.url);
      const text = await response.text();
      const errorText = extractErrorText(text);
      if (isInvalidCredentialText(errorText)) throw new CasAutomationError("CAS_INVALID_CREDENTIALS", "学号或统一认证密码错误");
      // Prefer the challenges the user can actually clear — SMS first, then image
      // captcha — over the slider. The slider div is often present in the page
      // template alongside a real SMS/captcha prompt, so checking it last avoids
      // reporting an unsolvable slider when a solvable SMS path is on offer.
      if (hasSmsChallenge(text, response.url)) return this.completeSms(jar, response.url, text, attempt, active);
      if (hasImageCaptcha(text, errorText)) {
        if (round + 1 >= MAX_CAPTCHA_ATTEMPTS) throw new CasAutomationError("CAS_CAPTCHA_FAILED", "图形验证码校验多次失败，请重新发起认证");
        page = await this.reloadLoginPage(jar, page.url, active);
        captcha = await this.promptCaptcha(jar, attempt, page.url, active);
        continue;
      }
      if (hasSliderChallenge(text)) throw new CasAutomationError("CAS_CAPTCHA_SLIDER", "统一认证要求滑块验证码，请在学校统一认证官方页面完成验证后重试");
      if (errorText) throw new CasAutomationError("CAS_LOGIN_FAILED", errorText);
      throw new CasAutomationError("CAS_LOGIN_FAILED", "统一认证登录未返回图书馆授权码");
    }
    throw new CasAutomationError("CAS_CAPTCHA_FAILED", "图形验证码校验多次失败，请重新发起认证");
  }

  private async reloadLoginPage(jar: ProtocolCookieJar, loginUrl: string, active: ActiveAttempt): Promise<LoginPage> {
    const response = await this.fetchFollow(jar, loginUrl, { signal: active.abortController.signal });
    const text = await response.text();
    const code = this.authorizationCode(response.url);
    if (code) throw new CasAutomationError("CAS_LOGIN_ALREADY_COMPLETE", "统一认证已完成");
    if (!response.url.includes("authserver.njau.edu.cn")) throw new CasAutomationError("CAS_LOGIN_PAGE_NOT_FOUND", "未能进入统一认证登录页");
    return extractLoginPage(text, response.url);
  }

  private async fetchCaptchaImage(jar: ProtocolCookieJar, referer: string, active: ActiveAttempt): Promise<string> {
    const url = new URL("/authserver/getCaptcha.htl", AUTH_BASE_URL);
    url.searchParams.set("_", String(Date.now()));
    const response = await this.request(jar, url, {
      signal: active.abortController.signal,
      headers: { referer, accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
    if (response.status >= 400) throw new CasAutomationError("CAS_CAPTCHA_FETCH_FAILED", "图形验证码获取失败，请稍后重试");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) throw new CasAutomationError("CAS_CAPTCHA_FETCH_FAILED", "图形验证码获取失败，请稍后重试");
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  }

  private async promptCaptcha(jar: ProtocolCookieJar, attempt: AttemptRow, referer: string, active: ActiveAttempt): Promise<string> {
    const image = await this.fetchCaptchaImage(jar, referer, active);
    const captchaExpiresAt = Date.now() + CAPTCHA_TTL_MS;
    await this.env.DB.prepare(
      `UPDATE official_login_attempts
          SET status = 'CAPTCHA_REQUIRED', progress = ?, captcha_image = ?, captcha_expires_at = ?, updated_at = ?
        WHERE id = ?`,
    ).bind("请输入图片中的验证码", image, captchaExpiresAt, Date.now(), attempt.id).run();
    if (attempt.purpose === "AUTO_RECOVERY") {
      const user = await this.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(attempt.user_id).first<{ email: string }>();
      if (user) await queueMail(this.env, user.email, "OFFICIAL_REAUTH_REQUIRED", {}, {
        dedupeKey: `official-reauth:${attempt.id}:${attempt.user_id}`,
      });
    }
    return this.waitForCaptchaCode(attempt.id, captchaExpiresAt);
  }

  private waitForCaptchaCode(attemptId: string, expiresAt: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const active = this.active.get(attemptId);
      if (!active) {
        reject(new CasAutomationError("CAS_ATTEMPT_NOT_RUNNING", "认证任务已中断"));
        return;
      }
      const timeout = setTimeout(() => {
        cleanup();
        reject(new CasAutomationError("CAS_CAPTCHA_EXPIRED", "图形验证码提交已超时"));
      }, Math.max(0, expiresAt - Date.now()));
      const abort = () => {
        cleanup();
        reject(new CasAutomationError("CAS_ATTEMPT_CANCELLED", "认证任务已取消"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        active.abortController.signal.removeEventListener("abort", abort);
        if (active.captchaResolver === resolver) active.captchaResolver = undefined;
        if (active.captchaRejecter === rejecter) active.captchaRejecter = undefined;
      };
      const resolver = (code: string) => {
        cleanup();
        resolve(code);
      };
      const rejecter = (error: unknown) => {
        cleanup();
        reject(error);
      };
      active.captchaResolver = resolver;
      active.captchaRejecter = rejecter;
      active.abortController.signal.addEventListener("abort", abort, { once: true });
    });
  }

  private async submitPassword(
    jar: ProtocolCookieJar,
    page: LoginPage,
    studentId: string,
    password: string,
    captcha: string,
    active: ActiveAttempt,
  ): Promise<Response> {
    const service = serviceUrlFromLoginUrl(page.url);
    const fields = {
      ...page.fields,
      username: studentId,
      password: encryptCasPassword(password, page.pwdEncryptSalt),
      captcha,
      _eventId: page.fields._eventId || "submit",
      cllt: "userNameLogin",
      dllt: page.fields.dllt || "generalLogin",
      lt: page.fields.lt || "",
      execution: page.execution,
    };
    return this.fetchFollow(jar, withService(page.action, service), {
      method: "POST",
      body: formBody(fields),
      signal: active.abortController.signal,
      headers: {
        origin: AUTH_BASE_URL,
        referer: page.url,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
  }

  private authorizationCode(url: string): string | null {
    try {
      const target = new URL(url);
      if (target.hostname.endsWith("libyy.njau.edu.cn")) return target.searchParams.get("code");
      return null;
    } catch {
      return null;
    }
  }

  private async completeSms(
    jar: ProtocolCookieJar,
    responseUrl: string,
    html: string,
    attempt: AttemptRow,
    active: ActiveAttempt,
  ): Promise<ProtocolLoginResult> {
    await this.trySendSmsCode(jar, responseUrl, html, active);
    const smsExpiresAt = Date.now() + SMS_TTL_MS;
    await this.progress(attempt.id, "SMS_REQUIRED", "请输入发送到绑定手机的 6 位短信验证码", smsExpiresAt);
    if (attempt.purpose === "AUTO_RECOVERY") {
      const user = await this.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(attempt.user_id).first<{ email: string }>();
      if (user) await queueMail(this.env, user.email, "OFFICIAL_REAUTH_REQUIRED", {}, {
        dedupeKey: `official-reauth:${attempt.id}:${attempt.user_id}`,
      });
    }

    let currentHtml = html;
    let currentUrl = responseUrl;
    for (let index = 0; index < 3; index += 1) {
      const code = await this.waitForSmsCode(attempt.id, smsExpiresAt);
      const response = await this.submitSmsCode(jar, currentUrl, currentHtml, code, active);
      const authCode = this.authorizationCode(response.url);
      if (authCode) return this.exchangeAuthorizationCode(jar, authCode, active, attempt.id, response.url);
      const text = await response.text();
      const payload = parseJsonMaybe(text);
      if (payload && typeof payload === "object") {
        const resultCode = String((payload as { code?: unknown }).code ?? "");
        if (["reAuth_failed", "reAuth_unauthorized"].includes(resultCode)) {
          const message = String((payload as { msg?: unknown; message?: unknown }).msg ?? (payload as { message?: unknown }).message ?? "短信验证码错误");
          if (index >= 2) throw new CasAutomationError("CAS_SMS_FAILED", message);
          await this.progress(attempt.id, "SMS_REQUIRED", message, smsExpiresAt);
          continue;
        }
      }
      const followUp = await this.fetchFollow(jar, `${AUTH_BASE_URL}/authserver/login?${new URLSearchParams({ service: serviceUrlFromLoginUrl(currentUrl) || String(extractReauthParams(currentHtml).service ?? "") })}`, {
        signal: active.abortController.signal,
        headers: { referer: currentUrl },
      });
      const followCode = this.authorizationCode(followUp.url);
      if (followCode) return this.exchangeAuthorizationCode(jar, followCode, active, attempt.id, followUp.url);
      currentHtml = await followUp.text();
      currentUrl = followUp.url;
      const errorText = extractErrorText(currentHtml);
      if (index >= 2 || !hasSmsChallenge(currentHtml, currentUrl)) {
        throw new CasAutomationError("CAS_SMS_FAILED", errorText || "短信验证码校验失败");
      }
      await this.progress(attempt.id, "SMS_REQUIRED", errorText || "短信验证码校验失败，请重新输入", smsExpiresAt);
    }
    throw new CasAutomationError("CAS_SMS_ATTEMPTS_EXCEEDED", "短信验证码尝试次数已用完");
  }

  private async trySendSmsCode(jar: ProtocolCookieJar, responseUrl: string, html: string, active: ActiveAttempt): Promise<void> {
    const reauth = extractReauthParams(html);
    const candidates: Array<{ url: string; data: Record<string, string> }> = [];
    if (Object.keys(reauth).length) {
      candidates.push({
        url: `${AUTH_BASE_URL}/authserver/dynamicCode/getDynamicCodeByReauth.do`,
        data: {
          userName: String(reauth.reAuthUserId ?? ""),
          authCodeTypeName: reauthCodeType(String(reauth.reAuthType ?? "")),
        },
      });
    }
    candidates.push(
      { url: `${AUTH_BASE_URL}/authserver/reAuth/getDynamicCode.htl`, data: {} },
      { url: `${AUTH_BASE_URL}/authserver/reAuth/sendDynamicCode.htl`, data: {} },
      { url: `${AUTH_BASE_URL}/authserver/dynamicCode/getDynamicCode.htl`, data: {} },
    );
    for (const candidate of candidates) {
      try {
        const response = await this.request(jar, candidate.url, {
          method: "POST",
          body: formBody(candidate.data),
          signal: active.abortController.signal,
          headers: {
            origin: AUTH_BASE_URL,
            referer: responseUrl,
            "x-requested-with": "XMLHttpRequest",
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json,text/plain,*/*",
          },
        });
        if (response.status < 400) return;
      } catch {
        // Try the next known CAS SMS endpoint; page variants differ across deployments.
      }
    }
  }

  private async submitSmsCode(
    jar: ProtocolCookieJar,
    responseUrl: string,
    html: string,
    code: string,
    active: ActiveAttempt,
  ): Promise<Response> {
    const reauth = extractReauthParams(html);
    const data = smsFormData(html);
    data.dynamicCode = code;
    const action = Object.keys(reauth).length
      ? `${AUTH_BASE_URL}/authserver/reAuthCheck/reAuthSubmit.do`
      : withService(new URL(parseForm(html, "pwdFromId")?.attrs.action || parseForm(html, "phoneFromId")?.attrs.action || "/authserver/login", responseUrl).toString(), serviceUrlFromLoginUrl(responseUrl));
    return this.fetchFollow(jar, action, {
      method: "POST",
      body: formBody(data),
      signal: active.abortController.signal,
      headers: {
        origin: AUTH_BASE_URL,
        referer: responseUrl,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
  }

  private waitForSmsCode(attemptId: string, expiresAt: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const active = this.active.get(attemptId);
      if (!active) {
        reject(new CasAutomationError("CAS_ATTEMPT_NOT_RUNNING", "认证任务已中断"));
        return;
      }
      const timeout = setTimeout(() => {
        cleanup();
        reject(new CasAutomationError("CAS_SMS_EXPIRED", "短信验证码提交已超时"));
      }, Math.max(0, expiresAt - Date.now()));
      const abort = () => {
        cleanup();
        reject(new CasAutomationError("CAS_ATTEMPT_CANCELLED", "认证任务已取消"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        active.abortController.signal.removeEventListener("abort", abort);
        if (active.smsResolver === resolver) active.smsResolver = undefined;
        if (active.smsRejecter === rejecter) active.smsRejecter = undefined;
      };
      const resolver = (code: string) => {
        cleanup();
        resolve(code);
      };
      const rejecter = (error: unknown) => {
        cleanup();
        reject(error);
      };
      active.smsResolver = resolver;
      active.smsRejecter = rejecter;
      active.abortController.signal.addEventListener("abort", abort, { once: true });
    });
  }

  private async exchangeAuthorizationCode(
    jar: ProtocolCookieJar,
    code: string,
    active: ActiveAttempt,
    attemptId: string,
    referer: string,
  ): Promise<ProtocolLoginResult> {
    await this.progress(attemptId, "RUNNING", "正在换取图书馆登录凭证").catch(() => undefined);
    const url = new URL("/api/studyroom/v1/userAccount/accessToken", this.env.LIBYY_API_BASE_URL);
    url.searchParams.set("code", code);
    const response = await this.request(jar, url, {
      method: "POST",
      signal: active.abortController.signal,
      headers: {
        origin: this.env.LIBYY_API_BASE_URL,
        referer,
        accept: "application/json,text/plain,*/*",
      },
    });
    const text = await response.text();
    const parsed = parseJsonMaybe(text);
    if (!response.ok) throw new CasAutomationError("CAS_TOKEN_EXCHANGE_FAILED", "图书馆登录凭证换取失败", text.slice(0, 200));
    return tokenResultFromResponse(parsed);
  }
}
