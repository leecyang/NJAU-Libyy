import type { AppEnv } from "../config";
import { flag } from "../config";
import { decryptSecret, encryptSecret } from "./crypto";
import { renderTemplate, retryDelayMs } from "./mail-content";
import { sendSmtpMail } from "./smtp";

export async function queueMail(
  env: AppEnv,
  recipientEmail: string,
  template: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO email_outbox
      (id, recipient_email, template, payload_json, status, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
  ).bind(crypto.randomUUID(), recipientEmail, template, await encryptSecret(JSON.stringify(payload), env.TOKEN_ENCRYPTION_KEY), Date.now(), Date.now()).run();
}

type OutboxRow = {
  id: string;
  recipient_email: string;
  template: string;
  payload_json: string;
  attempt_count: number;
};

export async function deliverDueMail(env: AppEnv, now = Date.now()): Promise<void> {
  if (!flag(env, "EMAIL_DELIVERY_ENABLED") || !env.SMTP_PASSWORD) return;
  const rows = await env.DB.prepare(
    `SELECT id, recipient_email, template, payload_json, attempt_count
       FROM email_outbox
      WHERE status = 'PENDING'
        AND COALESCE(next_attempt_at, 0) <= ?
        AND (delivery_lock_until IS NULL OR delivery_lock_until < ?)
      ORDER BY created_at LIMIT 20`,
  ).bind(now, now).all<OutboxRow>();

  for (const row of rows.results) {
    const lockUntil = now + 60_000;
    const claimed = await env.DB.prepare(
      `UPDATE email_outbox
          SET delivery_lock_until = ?, attempt_count = attempt_count + 1
        WHERE id = ? AND status = 'PENDING'
          AND (delivery_lock_until IS NULL OR delivery_lock_until < ?)`,
    ).bind(lockUntil, row.id, now).run();
    if (claimed.meta.changes !== 1) continue;
    const attemptCount = row.attempt_count + 1;
    try {
      const payload = JSON.parse(await decryptSecret(row.payload_json, env.TOKEN_ENCRYPTION_KEY)) as Record<string, unknown>;
      const rendered = renderTemplate(row.template, payload);
      await sendSmtpMail(env, { recipientEmail: row.recipient_email, ...rendered });
      await env.DB.prepare(
        `UPDATE email_outbox
            SET status = 'SENT', sent_at = ?, delivery_lock_until = NULL,
                last_error_message = NULL
          WHERE id = ? AND delivery_lock_until = ?`,
      ).bind(Date.now(), row.id, lockUntil).run();
    } catch {
      const delay = retryDelayMs(attemptCount);
      await env.DB.prepare(
        `UPDATE email_outbox
            SET status = ?, next_attempt_at = ?, delivery_lock_until = NULL,
                last_error_message = '邮件发送失败'
          WHERE id = ? AND delivery_lock_until = ?`,
      ).bind(delay === null ? "FAILED" : "PENDING", delay === null ? null : Date.now() + delay, row.id, lockUntil).run();
    }
  }
}
