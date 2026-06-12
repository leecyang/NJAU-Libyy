ALTER TABLE email_outbox ADD COLUMN dedupe_key TEXT;

CREATE UNIQUE INDEX email_outbox_dedupe_idx
  ON email_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
