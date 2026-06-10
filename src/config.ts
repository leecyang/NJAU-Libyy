import type { AppDatabase } from "./db/types";
import type { CasAutomationAdapter } from "./lib/cas-types";
import type { OfficialAccessGateway } from "./lib/official-gateway-types";

export type AppEnv = {
  DB: AppDatabase;
  CAS_AUTOMATION?: CasAutomationAdapter;
  OFFICIAL_GATEWAY?: OfficialAccessGateway;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  LIBYY_APP_ID: string;
  LIBYY_API_BASE_URL: string;
  OFFICIAL_NETWORK_MODE?: "tailscale-direct" | "http-proxy";
  NJAU_PROXY_ENDPOINT?: string;
  TS_EXTRA_ARGS?: string;
  APP_BASE_URL: string;
  ENVIRONMENT: string;
  APP_VERSION: string;
  ALLOWED_EMAIL_DOMAINS: string;
  VERIFICATION_CODE_TTL_SECONDS?: string;
  INVITATION_TTL_SECONDS?: string;
  TEAM_INVITATION_TTL_SECONDS?: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_SECURE: string;
  SMTP_USERNAME: string;
  SMTP_FROM_ADDRESS: string;
  SMTP_FROM_NAME: string;
  EMAIL_DELIVERY_ENABLED?: string;
  ENABLE_OFFICIAL_RESERVATION_SUBMISSION?: string;
  ENABLE_SINGLE_RESERVATION_SUBMISSION?: string;
  ENABLE_MULTIMEMBER_RESERVATION_SUBMISSION?: string;
  ENABLE_SIGN_LINK_GENERATION?: string;
  ENABLE_AUTO_SIGN_SUBMISSION?: string;
  ENABLE_SIGNOUT_SUBMISSION?: string;
  ENABLE_SIGN_PARAMETER_INGEST?: string;
  SIGN_LINK_BASE_URL: string;
  DEV_EXPOSE_VERIFICATION_CODES?: string;
  PREVIEW_DEMO_ROOMS?: string;
  LIBYY_APP_SECRET?: string;
  NJAU_PROXY_TOKEN?: string;
  TOKEN_ENCRYPTION_KEY: string;
  CAS_CREDENTIAL_ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  PASSWORD_HASH_SECRET?: string;
  SMTP_PASSWORD?: string;
  SIGN_ROOM_SYSTEM_MAC_MAP?: string;
  AUTHORIZED_SIGN_SYSTEM_MAC?: string;
  AUTHORIZED_SIGN_ROOM_ID?: string;
  SCHEDULER_MAX_RUNTIME_MS?: string;
  SCHEDULER_REFRESH_LIMIT?: string;
  SCHEDULER_PREPARE_LIMIT?: string;
  SCHEDULER_RESERVATION_SUBMIT_LIMIT?: string;
  SCHEDULER_SYNC_LIMIT?: string;
  SCHEDULER_SIGN_LIMIT?: string;
  SCHEDULER_SIGNOUT_LIMIT?: string;
  SCHEDULER_MAIL_LIMIT?: string;
  PLAYWRIGHT_PROFILE_DIR?: string;
  PLAYWRIGHT_MAX_CONCURRENCY?: string;
  CAS_LOGIN_TIMEOUT_MS?: string;
  OFFICIAL_READ_CONCURRENCY?: string;
  OFFICIAL_WRITE_CONCURRENCY?: string;
  OFFICIAL_REQUEST_MIN_INTERVAL_MS?: string;
  OFFICIAL_JOB_POLL_INTERVAL_MS?: string;
};

export function flag(env: AppEnv, name: keyof AppEnv): boolean {
  return String(env[name]).toLowerCase() === "true";
}

export function integerVar(env: AppEnv, name: keyof AppEnv, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}
