import type { AppEnv } from "../config";
import { encryptSecret } from "./crypto";

export async function queueMail(
  env: AppEnv,
  recipientEmail: string,
  template: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO email_outbox (id, recipient_email, template, payload_json, status, created_at)
     VALUES (?, ?, ?, ?, 'PENDING', ?)`,
  ).bind(crypto.randomUUID(), recipientEmail, template, await encryptSecret(JSON.stringify(payload), env.TOKEN_ENCRYPTION_KEY), Date.now()).run();
}
