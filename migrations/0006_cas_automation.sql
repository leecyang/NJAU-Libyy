CREATE TABLE official_login_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  last_login_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE official_login_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('INITIAL_BIND', 'REBIND', 'AUTO_RECOVERY')),
  student_id TEXT NOT NULL,
  pending_password_ciphertext TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SMS_REQUIRED', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  progress TEXT NOT NULL,
  sms_attempt_count INTEGER NOT NULL DEFAULT 0,
  sms_expires_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX official_login_attempts_user_status_idx
  ON official_login_attempts(user_id, status, created_at DESC);
