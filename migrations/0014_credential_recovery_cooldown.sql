ALTER TABLE official_credentials ADD COLUMN recovery_blocked_until INTEGER;
ALTER TABLE official_credentials ADD COLUMN last_recovery_attempt_at INTEGER;

CREATE INDEX official_credentials_refresh_due_idx
  ON official_credentials(credential_status, last_refresh_success_at, recovery_blocked_until);
