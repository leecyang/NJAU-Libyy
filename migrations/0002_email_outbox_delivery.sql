ALTER TABLE email_outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE email_outbox ADD COLUMN last_error_message TEXT;
ALTER TABLE email_outbox ADD COLUMN delivery_lock_until INTEGER;

CREATE INDEX email_outbox_delivery_idx
  ON email_outbox(status, next_attempt_at, created_at);
