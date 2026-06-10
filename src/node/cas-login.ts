import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppEnv } from "../config";
import type { User } from "../lib/auth";
import { audit } from "../lib/audit";
import type { CasAttemptPublic, CasAttemptPurpose, CasAttemptStatus, CasAutomationAdapter } from "../lib/cas-types";
import { bindCredentialFromToken } from "../lib/credentials";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { queueMail } from "../lib/mail";

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
  error_code: string | null;
  error_message: string | null;
  expires_at: number;
};

type ActiveAttempt = {
  context: BrowserContext;
  smsResolver?: (code: string) => void;
};

type CasEntryState = "PASSWORD" | "SMS" | "AUTHENTICATED";

const ACTIVE_STATUSES = "('QUEUED', 'RUNNING', 'SMS_REQUIRED')";
const ATTEMPT_TTL_MS = 10 * 60_000;
const SMS_TTL_MS = 5 * 60_000;
const SMS_INPUT_SELECTOR = '#dynamicCode, input[name="dynamicCode"], input[placeholder*="短信验证码"], #smsCode, #verifyCode, input[name="smsCode"]';
const SMS_INPUT_TIMEOUT_MS = 15_000;
const SMS_ACTION_TIMEOUT_MS = 5_000;

class CasAutomationError extends Error {
  constructor(readonly code: string, message: string, readonly internalDetail?: string) {
    super(message);
  }
}

function publicAttempt(row: AttemptRow): CasAttemptPublic {
  return {
    attemptId: row.id,
    status: row.status,
    purpose: row.purpose,
    progress: row.progress,
    smsExpiresAt: row.sms_expires_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function isStudentId(value: string): boolean {
  return /^[0-9A-Za-z]{4,32}$/.test(value);
}

export function casProfilePath(root: string, userId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid user id for profile path");
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, userId);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Invalid profile path");
  return target;
}

async function visible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().isVisible().catch(() => false);
}

export function isAbortedNavigation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("net::ERR_ABORTED") || message.includes("Navigation interrupted by another one");
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
              pending_password_ciphertext = NULL, updated_at = ?
        WHERE status IN ('RUNNING', 'SMS_REQUIRED')`,
    ).bind(now).run();
    await this.env.DB.prepare(
      `UPDATE official_login_attempts
          SET status = 'EXPIRED', progress = '认证任务已过期',
              error_code = 'CAS_ATTEMPT_EXPIRED', error_message = '认证任务已过期',
              pending_password_ciphertext = NULL, updated_at = ?
        WHERE status = 'QUEUED'`,
    ).bind(now).run();
    await fs.mkdir(this.profileRoot(), { recursive: true, mode: 0o700 });
  }

  async startAttempt(userId: string, studentId: string, password: string, purpose: CasAttemptPurpose): Promise<CasAttemptPublic> {
    if (!isStudentId(studentId)) throw new HttpError(400, "INVALID_STUDENT_ID", "学号格式错误");
    if (!password || password.length > 128) throw new HttpError(400, "INVALID_CAS_PASSWORD", "统一认证密码格式错误");
    const current = await this.env.DB.prepare(
      `SELECT id FROM official_login_attempts WHERE user_id = ? AND status IN ${ACTIVE_STATUSES} ORDER BY created_at DESC LIMIT 1`,
    ).bind(userId).first<{ id: string }>();
    if (current) throw new HttpError(409, "CAS_ATTEMPT_IN_PROGRESS", "已有统一认证任务正在进行");

    const now = Date.now();
    const row: AttemptRow = {
      id: crypto.randomUUID(),
      user_id: userId,
      purpose,
      student_id: studentId,
      pending_password_ciphertext: await encryptSecret(password, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY),
      status: "QUEUED",
      progress: "等待启动浏览器",
      sms_attempt_count: 0,
      sms_expires_at: null,
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
              sms_attempt_count, sms_expires_at, error_code, error_message, expires_at
         FROM official_login_attempts WHERE user_id = ? AND status IN ${ACTIVE_STATUSES}
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(userId).first<AttemptRow>();
    if (active) return publicAttempt(active);
    const stored = await this.env.DB.prepare(
      "SELECT student_id, password_ciphertext FROM official_login_credentials WHERE user_id = ?",
    ).bind(userId).first<{ student_id: string; password_ciphertext: string }>();
    if (!stored) return null;
    const password = await decryptSecret(stored.password_ciphertext, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY);
    return this.startAttempt(userId, stored.student_id, password, "AUTO_RECOVERY");
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
      "UPDATE official_login_attempts SET sms_attempt_count = sms_attempt_count + 1, progress = ?, updated_at = ? WHERE id = ? AND status = 'SMS_REQUIRED'",
    ).bind("正在校验短信验证码", Date.now(), attemptId).run();
    const resolver = active.smsResolver;
    active.smsResolver = undefined;
    resolver(code);
    return publicAttempt({ ...row, sms_attempt_count: row.sms_attempt_count + 1, progress: "正在校验短信验证码" });
  }

  async removeUser(userId: string): Promise<void> {
    for (const [attemptId, active] of this.active) {
      const row = await this.attempt(attemptId);
      if (row?.user_id !== userId) continue;
      await active.context.close().catch(() => undefined);
      this.active.delete(attemptId);
    }
    await fs.rm(this.profilePath(userId), { recursive: true, force: true });
  }

  private profileRoot(): string {
    return path.resolve(this.env.PLAYWRIGHT_PROFILE_DIR || "/data/playwright-profiles");
  }

  private profilePath(userId: string): string {
    return casProfilePath(this.profileRoot(), userId);
  }

  private maxConcurrency(): number {
    const value = Number(this.env.PLAYWRIGHT_MAX_CONCURRENCY ?? "2");
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
              sms_attempt_count, sms_expires_at, error_code, error_message, expires_at
         FROM official_login_attempts WHERE id = ?`,
    ).bind(attemptId).first<AttemptRow>();
  }

  private async progress(attemptId: string, status: CasAttemptStatus, progress: string, smsExpiresAt: number | null = null): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE official_login_attempts SET status = ?, progress = ?, sms_expires_at = ?, updated_at = ? WHERE id = ?",
    ).bind(status, progress, smsExpiresAt, Date.now(), attemptId).run();
  }

  private async run(attemptId: string): Promise<void> {
    if (this.env.OFFICIAL_GATEWAY) {
      return this.env.OFFICIAL_GATEWAY.runPlaywright(`cas:${attemptId}`, () => this.runAttempt(attemptId));
    }
    return this.runAttempt(attemptId);
  }

  private async runAttempt(attemptId: string): Promise<void> {
    let context: BrowserContext | null = null;
    let stage = "LOAD_ATTEMPT";
    try {
      const attempt = await this.attempt(attemptId);
      if (!attempt?.pending_password_ciphertext || attempt.expires_at <= Date.now()) throw new CasAutomationError("CAS_ATTEMPT_EXPIRED", "认证任务已过期");
      const password = await decryptSecret(attempt.pending_password_ciphertext, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY);
      await this.progress(attemptId, "RUNNING", "正在启动独立浏览器环境");
      const profilePath = this.profilePath(attempt.user_id);
      await fs.mkdir(profilePath, { recursive: true, mode: 0o700 });
      await fs.chmod(profilePath, 0o700);
      stage = "LAUNCH_BROWSER";
      try {
        context = await chromium.launchPersistentContext(profilePath, {
          headless: true,
          chromiumSandbox: true,
          viewport: { width: 1365, height: 768 },
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes("Chromium sandboxing failed") || detail.includes("No usable sandbox")) {
          throw new CasAutomationError(
            "CAS_BROWSER_SANDBOX_UNAVAILABLE",
            "服务器浏览器沙箱未正确配置，请联系管理员更新部署配置",
            detail,
          );
        }
        throw new CasAutomationError(
          "CAS_BROWSER_START_FAILED",
          "统一认证浏览器启动失败，请稍后重试",
          detail,
        );
      }
      this.active.set(attemptId, { context });
      const page = context.pages()[0] ?? await context.newPage();
      stage = "CLEAR_LIBYY_STATE";
      await this.clearLibyyState(context);
      await this.progress(attemptId, "RUNNING", "正在打开南京农业大学统一认证");
      stage = "OPEN_CAS";
      try {
        await page.goto(new URL("/student/studentIndex", this.env.LIBYY_API_BASE_URL).toString(), {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      } catch (error) {
        if (!isAbortedNavigation(error)) throw error;
      }
      const entryState = await this.waitForCasEntry(page);
      if (entryState === "PASSWORD") {
        stage = "SUBMIT_PASSWORD";
        await this.submitPassword(page, attempt.student_id, password);
        stage = "WAIT_AFTER_PASSWORD";
        await this.waitAfterPassword(attempt, page);
      } else if (entryState === "SMS") {
        stage = "WAIT_AFTER_PASSWORD";
        await this.handleSms(attempt, page);
      }
      stage = "READ_TOKEN";
      const reflushToken = await this.waitForToken(page);
      const user = await this.env.DB.prepare(
        `SELECT id, email, role, status, student_id, real_name, allow_auto_join_reservation, square_visibility
           FROM users WHERE id = ?`,
      ).bind(attempt.user_id).first<User>();
      if (!user) throw new CasAutomationError("ACCOUNT_NOT_FOUND", "账号不存在");
      stage = "BIND_CREDENTIAL";
      await bindCredentialFromToken(this.env, user, reflushToken, attempt.student_id);
      const passwordCiphertext = await encryptSecret(password, this.env.CAS_CREDENTIAL_ENCRYPTION_KEY);
      const now = Date.now();
      await this.env.DB.prepare(
        `INSERT INTO official_login_credentials
          (user_id, student_id, password_ciphertext, last_login_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           student_id = excluded.student_id, password_ciphertext = excluded.password_ciphertext,
           last_login_at = excluded.last_login_at, last_error_code = NULL, updated_at = excluded.updated_at`,
      ).bind(attempt.user_id, attempt.student_id, passwordCiphertext, now, now, now).run();
      await this.env.DB.prepare(
        `UPDATE official_login_attempts
            SET status = 'SUCCEEDED', progress = '统一认证完成', pending_password_ciphertext = NULL,
                sms_expires_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ?`,
      ).bind(now, attemptId).run();
      await audit(this.env.DB, { actorUserId: attempt.user_id, actorType: attempt.purpose === "AUTO_RECOVERY" ? "SYSTEM" : "USER", action: "CAS_LOGIN_SUCCEEDED", targetType: "CREDENTIAL", targetId: attempt.user_id, result: "SUCCESS", metadata: { purpose: attempt.purpose } });
    } catch (error) {
      const code = error instanceof CasAutomationError ? error.code : error instanceof HttpError ? error.code : "CAS_AUTOMATION_FAILED";
      const message = error instanceof CasAutomationError || error instanceof HttpError ? error.message : "统一认证自动化失败，请稍后重试";
      const status: CasAttemptStatus = code === "CAS_ATTEMPT_EXPIRED" || code === "CAS_SMS_EXPIRED" ? "EXPIRED" : "FAILED";
      await this.env.DB.prepare(
        `UPDATE official_login_attempts
            SET status = ?, progress = ?, pending_password_ciphertext = NULL, sms_expires_at = NULL,
                error_code = ?, error_message = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'EXPIRED')`,
      ).bind(status, message, code, message, Date.now(), attemptId).run();
      const failedAttempt = await this.attempt(attemptId);
      if (failedAttempt?.purpose === "AUTO_RECOVERY") {
        const user = await this.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(failedAttempt.user_id).first<{ email: string }>();
        if (user) await queueMail(this.env, user.email, "OFFICIAL_REAUTH_REQUIRED", {});
      }
      const detail = error instanceof CasAutomationError && error.internalDetail
        ? error.internalDetail
        : error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      console.error(JSON.stringify({ level: "error", event: "cas_login_failed", attemptId, stage, code, detail, stack }));
    } finally {
      this.active.delete(attemptId);
      await context?.close().catch(() => undefined);
    }
  }

  private async clearLibyyState(context: BrowserContext): Promise<void> {
    const cookies = await context.cookies();
    await context.clearCookies();
    const preserved = cookies.filter((cookie) => !cookie.domain.endsWith("libyy.njau.edu.cn"));
    if (preserved.length) await context.addCookies(preserved);
    const cleanupPage = await context.newPage();
    try {
      await cleanupPage.goto(new URL("/favicon.ico", this.env.LIBYY_API_BASE_URL).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await cleanupPage.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
    } catch (error) {
      throw new CasAutomationError(
        "CAS_STORAGE_RESET_FAILED",
        "清理图书馆旧登录状态失败，请稍后重试",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await cleanupPage.close().catch(() => undefined);
    }
  }

  private async waitForCasEntry(page: Page): Promise<CasEntryState> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const url = page.url();
      if (url.includes("/student/studentIndex")) {
        const token = await page.evaluate(() => localStorage.getItem("reflushToken")).catch(() => null);
        if (token) return "AUTHENTICATED";
      }
      if (await visible(page, SMS_INPUT_SELECTOR)) return "SMS";
      if (url.includes("authserver.njau.edu.cn") && await page.locator("#pwdEncryptSalt").count()) return "PASSWORD";
      await page.waitForTimeout(200);
    }
    throw new CasAutomationError("CAS_LOGIN_PAGE_NOT_FOUND", "未能进入统一认证登录页或图书馆主页");
  }

  private async submitPassword(page: Page, studentId: string, password: string): Promise<void> {
    if (await visible(page, "#pwdFromId #captcha") || await visible(page, "#sliderCaptchaDiv > *")) {
      throw new CasAutomationError("CAS_CAPTCHA_REQUIRED", "统一认证要求图形或滑块验证码，请稍后重试");
    }
    await page.waitForFunction(() => typeof (window as Window & { encryptPassword?: unknown }).encryptPassword === "function", undefined, { timeout: 15_000 });
    await page.evaluate(({ account, secret }) => {
      const username = document.querySelector<HTMLInputElement>("#pwdFromId #username");
      const passwordInput = document.querySelector<HTMLInputElement>("#pwdFromId #password");
      const saltPassword = document.querySelector<HTMLInputElement>("#pwdFromId #saltPassword");
      const salt = document.querySelector<HTMLInputElement>("#pwdFromId #pwdEncryptSalt")?.value;
      const form = document.querySelector<HTMLFormElement>("#pwdFromId");
      const encrypt = (window as Window & { encryptPassword?: (value: string, salt: string) => string }).encryptPassword;
      if (!username || !passwordInput || !saltPassword || !salt || !form || !encrypt) throw new Error("CAS password form is incomplete");
      username.value = account;
      passwordInput.value = secret;
      saltPassword.value = encrypt(secret, salt);
      passwordInput.disabled = true;
      form.submit();
    }, { account: studentId, secret: password });
  }

  private async waitAfterPassword(attempt: AttemptRow, page: Page): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const url = page.url();
      if (url.includes("/student/studentIndex")) return;
      if (await visible(page, SMS_INPUT_SELECTOR)) {
        await this.handleSms(attempt, page);
        return;
      }
      if (url.includes("reAuthCheck") || url.includes("reAuthLoginView")) {
        await this.waitForSmsInput(page);
        await this.handleSms(attempt, page);
        return;
      }
      if (url.includes("authserver.njau.edu.cn")) {
        if (await visible(page, "#pwdFromId #captcha") || await visible(page, "#sliderCaptchaDiv > *")) {
          throw new CasAutomationError("CAS_CAPTCHA_REQUIRED", "统一认证要求图形或滑块验证码，请稍后重试");
        }
        const errorText = (await page.locator("#showErrorTip").textContent().catch(() => ""))?.trim();
        if (errorText) throw new CasAutomationError("CAS_INVALID_CREDENTIALS", "学号或统一认证密码错误");
      }
      await page.waitForTimeout(200);
    }
    throw new CasAutomationError("CAS_LOGIN_TIMEOUT", "统一认证登录超时");
  }

  private async waitForSmsInput(page: Page): Promise<void> {
    try {
      await page.locator(SMS_INPUT_SELECTOR).filter({ visible: true }).first().waitFor({
        state: "visible",
        timeout: SMS_INPUT_TIMEOUT_MS,
      });
    } catch (error) {
      throw new CasAutomationError(
        "CAS_SMS_FORM_NOT_FOUND",
        "统一认证已进入二次验证，但短信验证码输入框未加载，请稍后重试",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private smsInput(page: Page) {
    return page.locator(SMS_INPUT_SELECTOR).filter({ visible: true }).first();
  }

  private async handleSms(attempt: AttemptRow, page: Page): Promise<void> {
    await this.waitForSmsInput(page);
    const send = page.locator("#getDynamicCode");
    if (await send.isVisible().catch(() => false)) {
      await send.click({ timeout: SMS_ACTION_TIMEOUT_MS });
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>("#getDynamicCode");
        const uuid = document.querySelector<HTMLInputElement>("#uuid");
        return Boolean(button?.disabled || uuid?.value || button?.textContent?.includes("秒"));
      }, undefined, { timeout: 15_000 }).catch(() => undefined);
    }
    const smsExpiresAt = Date.now() + SMS_TTL_MS;
    let codePromise = this.waitForSmsCode(attempt.id, smsExpiresAt);
    await this.progress(attempt.id, "SMS_REQUIRED", "请输入发送到绑定手机的 6 位短信验证码", smsExpiresAt);
    if (attempt.purpose === "AUTO_RECOVERY") {
      const user = await this.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(attempt.user_id).first<{ email: string }>();
      if (user) await queueMail(this.env, user.email, "OFFICIAL_REAUTH_REQUIRED", {});
    }

    for (let index = 0; index < 3; index += 1) {
      const code = await codePromise;
      const input = this.smsInput(page);
      try {
        await input.fill(code, { timeout: SMS_ACTION_TIMEOUT_MS });
      } catch (error) {
        throw new CasAutomationError(
          "CAS_SMS_INPUT_UNAVAILABLE",
          "短信验证码输入框当前不可用，请重新发起认证",
          error instanceof Error ? error.message : String(error),
        );
      }
      const submit = page.locator("button.auth_login_btn.submit_btn:visible").first();
      if (await submit.isVisible().catch(() => false)) await submit.click({ timeout: SMS_ACTION_TIMEOUT_MS });
      else await input.press("Enter", { timeout: SMS_ACTION_TIMEOUT_MS });
      const responseDeadline = Date.now() + 10_000;
      while (Date.now() < responseDeadline) {
        if (!page.url().includes("reAuthCheck") && !page.url().includes("reAuthLoginView") && !await this.smsInput(page).isVisible().catch(() => false)) return;
        const currentError = (await page.locator("#showErrorTip, .error, .el-message").first().textContent().catch(() => ""))?.trim();
        if (currentError) break;
        await page.waitForTimeout(300);
      }
      const errorText = (await page.locator("#showErrorTip, .error, .el-message").first().textContent().catch(() => ""))?.trim();
      if (index < 2) {
        codePromise = this.waitForSmsCode(attempt.id, smsExpiresAt);
        await this.progress(attempt.id, "SMS_REQUIRED", errorText || "短信验证码错误，请重新输入", smsExpiresAt);
      }
    }
    throw new CasAutomationError("CAS_SMS_ATTEMPTS_EXCEEDED", "短信验证码尝试次数已用完");
  }

  private waitForSmsCode(attemptId: string, expiresAt: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const active = this.active.get(attemptId);
      if (!active) {
        reject(new CasAutomationError("CAS_ATTEMPT_NOT_RUNNING", "认证任务已中断"));
        return;
      }
      active.smsResolver = resolve;
      const timeout = setTimeout(() => {
        if (active.smsResolver === resolve) active.smsResolver = undefined;
        reject(new CasAutomationError("CAS_SMS_EXPIRED", "短信验证码提交已超时"));
      }, Math.max(0, expiresAt - Date.now()));
      const originalResolve = active.smsResolver;
      active.smsResolver = (code) => {
        clearTimeout(timeout);
        originalResolve(code);
      };
    });
  }

  private async waitForToken(page: Page): Promise<string> {
    const deadline = Date.now() + this.loginTimeout();
    while (Date.now() < deadline) {
      if (page.url().includes("/student/studentIndex")) {
        const token = await page.evaluate(() => localStorage.getItem("reflushToken")).catch(() => null);
        if (token) return token;
      }
      await page.waitForTimeout(500);
    }
    throw new CasAutomationError("CAS_TOKEN_NOT_FOUND", "统一认证完成但未取得官方登录凭证");
  }
}
