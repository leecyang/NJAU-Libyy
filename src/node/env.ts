import { config as loadDotenv } from "dotenv";
import type { AppEnv } from "../config";
import type { AppDatabase } from "../db/types";
import { assertCompleteSignDeviceMap } from "../lib/reservations";

const defaults = {
  LIBYY_APP_ID: "41043f17-3c17-4f2e-894c-5d615f992db9",
  LIBYY_API_BASE_URL: "https://libyy.njau.edu.cn",
  OFFICIAL_NETWORK_MODE: "tailscale-direct",
  APP_BASE_URL: "http://localhost:3000",
  ENVIRONMENT: "production",
  APP_VERSION: "docker",
  ALLOWED_EMAIL_DOMAINS: "qq.com,163.com,126.com,yeah.net,sina.com,outlook.com",
  VERIFICATION_CODE_TTL_SECONDS: "600",
  INVITATION_TTL_SECONDS: "86400",
  TEAM_INVITATION_TTL_SECONDS: "604800",
  SMTP_HOST: "smtp.qiye.aliyun.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USERNAME: "noreply@mail.letsapi.store",
  SMTP_FROM_ADDRESS: "noreply@mail.letsapi.store",
  SMTP_FROM_NAME: "NJAU Libyy",
  EMAIL_DELIVERY_ENABLED: "true",
  ENABLE_OFFICIAL_RESERVATION_SUBMISSION: "true",
  ENABLE_SINGLE_RESERVATION_SUBMISSION: "true",
  ENABLE_MULTIMEMBER_RESERVATION_SUBMISSION: "true",
  ENABLE_SIGN_LINK_GENERATION: "true",
  ENABLE_AUTO_SIGN_SUBMISSION: "true",
  ENABLE_SIGNOUT_SUBMISSION: "true",
  ENABLE_SIGN_PARAMETER_INGEST: "false",
  SIGN_ROOM_SYSTEM_MAC_MAP: "{\"2\":\"ZP2441000049\",\"3\":\"ZP2441000075\",\"4\":\"ZP2441000077\",\"5\":\"ZP2441000062\",\"6\":\"ZP2441000058\",\"7\":\"ZP2441000069\",\"8\":\"ZP2441000076\",\"9\":\"ZP2441000066\",\"10\":\"ZP2441000056\",\"11\":\"ZP2441000059\",\"12\":\"ZP2441000065\",\"13\":\"ZP2441000050\",\"14\":\"ZP2441000054\",\"15\":\"ZP2441000055\",\"16\":\"ZP2441000067\",\"17\":\"ZP2441000061\",\"18\":\"ZP2441000068\",\"19\":\"ZP2441000078\",\"20\":\"ZP2441000071\",\"21\":\"ZP2441000051\",\"22\":\"ZP2441000072\",\"23\":\"ZP2441000052\",\"24\":\"ZP2441000074\",\"25\":\"ZP2441000073\",\"26\":\"ZP2441000057\",\"27\":\"ZP2441000070\"}",
  SIGN_LINK_BASE_URL: "https://libyy.njau.edu.cn/mStudent/codeSignIn/",
  DEV_EXPOSE_VERIFICATION_CODES: "false",
  SCHEDULER_MAX_RUNTIME_MS: "18000",
  SCHEDULER_REFRESH_LIMIT: "3",
  SCHEDULER_PREPARE_LIMIT: "5",
  SCHEDULER_RESERVATION_SUBMIT_LIMIT: "2",
  SCHEDULER_SYNC_LIMIT: "3",
  SCHEDULER_SIGN_LIMIT: "5",
  SCHEDULER_SIGNOUT_LIMIT: "5",
  SCHEDULER_MAIL_LIMIT: "2",
  OFFICIAL_READ_CONCURRENCY: "3",
  OFFICIAL_WRITE_CONCURRENCY: "1",
  OFFICIAL_REQUEST_MIN_INTERVAL_MS: "150",
  OFFICIAL_JOB_POLL_INTERVAL_MS: "250",
} satisfies Partial<AppEnv>;

const fallbackSecrets = {
  TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  SESSION_SECRET: "self-hosted-session-secret",
  PASSWORD_HASH_SECRET: "self-hosted-password-pepper",
} satisfies Pick<AppEnv, "TOKEN_ENCRYPTION_KEY" | "SESSION_SECRET" | "PASSWORD_HASH_SECRET">;

function usableSecret(value: string | undefined): boolean {
  if (!value) return false;
  return ![
    "replace-me",
    "replace-with-base64url-encoded-32-byte-key",
    "replace-with-base64-encoded-32-byte-key",
    "生成的32字节base64url密钥",
    "生成的随机长密钥",
  ].includes(value);
}

function validEncryptionKey(value: string | undefined): value is string {
  if (!value || !usableSecret(value)) return false;
  try {
    return Buffer.from(value, "base64url").byteLength === 32;
  } catch {
    return false;
  }
}

function loadFallbackSecrets(): Pick<AppEnv, "TOKEN_ENCRYPTION_KEY" | "SESSION_SECRET" | "PASSWORD_HASH_SECRET"> {
  const secrets = { ...fallbackSecrets };
  for (const name of Object.keys(secrets) as Array<keyof typeof secrets>) {
    if (usableSecret(process.env[name])) secrets[name] = process.env[name]!;
  }
  const fallbackNames = (Object.keys(secrets) as Array<keyof typeof secrets>).filter((name) => secrets[name] === fallbackSecrets[name]);
  if (fallbackNames.length) {
    console.warn(`[config] Using built-in fallback secret values for ${fallbackNames.join(", ")}. Set stable random values in .env for production.`);
  }
  return secrets;
}

export function loadNodeEnv(db: AppDatabase): AppEnv {
  loadDotenv({ quiet: true });
  const secrets = loadFallbackSecrets();
  if (!validEncryptionKey(process.env.CAS_CREDENTIAL_ENCRYPTION_KEY)) {
    throw new Error("CAS_CREDENTIAL_ENCRYPTION_KEY must be configured with a base64url-encoded 32-byte key");
  }
  if (process.env.CAS_CREDENTIAL_ENCRYPTION_KEY === secrets.TOKEN_ENCRYPTION_KEY) {
    throw new Error("CAS_CREDENTIAL_ENCRYPTION_KEY must be different from TOKEN_ENCRYPTION_KEY");
  }
  const env = {
    DB: db,
    ...defaults,
    ...process.env,
    ...secrets,
    CAS_CREDENTIAL_ENCRYPTION_KEY: process.env.CAS_CREDENTIAL_ENCRYPTION_KEY,
  } as AppEnv;
  assertCompleteSignDeviceMap(env.SIGN_ROOM_SYSTEM_MAC_MAP);
  return env;
}

export function nodePort(): number {
  const value = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(value) || value <= 0) throw new Error("PORT must be a positive integer");
  return value;
}
