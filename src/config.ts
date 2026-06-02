export type AppEnv = Env & {
  LIBYY_APP_SECRET?: string;
  NJAU_PROXY_TOKEN?: string;
  TOKEN_ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  PASSWORD_HASH_SECRET?: string;
  SMTP_PASSWORD?: string;
  SIGN_ROOM_SYSTEM_MAC_MAP?: string;
  AUTHORIZED_SIGN_SYSTEM_MAC?: string;
  AUTHORIZED_SIGN_ROOM_ID?: string;
};

export function flag(env: AppEnv, name: keyof Env): boolean {
  return String(env[name]).toLowerCase() === "true";
}

export function integerVar(env: AppEnv, name: keyof Env, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}
