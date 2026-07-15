ALTER TABLE users ADD COLUMN email_notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK (email_notifications_enabled IN (0, 1));

CREATE INDEX users_email_notifications_idx
  ON users(email_notifications_enabled, status);
