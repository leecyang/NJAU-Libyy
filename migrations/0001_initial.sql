PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_verified_at INTEGER NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BANNED', 'DELETED')),
  student_id TEXT UNIQUE,
  real_name TEXT,
  allow_auto_join_reservation INTEGER NOT NULL DEFAULT 0 CHECK (allow_auto_join_reservation IN (0, 1)),
  square_visibility TEXT NOT NULL DEFAULT 'VISIBLE' CHECK (square_visibility IN ('VISIBLE', 'HIDDEN')),
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_token_hash_idx ON sessions(token_hash);

CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  ip_hash TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX login_attempts_lookup_idx ON login_attempts(email, ip_hash, created_at);

CREATE TABLE email_verification_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('REGISTER', 'RESET_PASSWORD')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX verification_codes_lookup_idx ON email_verification_codes(email, purpose, created_at);

CREATE TABLE official_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  access_token_ciphertext TEXT NOT NULL,
  reflush_token_ciphertext TEXT NOT NULL,
  access_token_expires_seconds INTEGER NOT NULL,
  access_token_obtained_at INTEGER NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  credential_status TEXT NOT NULL CHECK (credential_status IN ('ACTIVE', 'REFRESHING', 'REFRESH_FAILED', 'REAUTH_REQUIRED', 'DISABLED')),
  refresh_lock_until INTEGER,
  last_refresh_attempt_at INTEGER,
  last_refresh_success_at INTEGER,
  refresh_failure_count INTEGER NOT NULL DEFAULT 0,
  last_error_code INTEGER,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE reservation_tasks (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  target_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  use_description TEXT NOT NULL DEFAULT '小组学习',
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'WAITING_WINDOW', 'WAITING_MEMBERS', 'READY', 'SUBMITTING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  official_reservation_id TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE reservation_task_candidate_rooms (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES reservation_tasks(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL,
  room_name_snapshot TEXT NOT NULL,
  priority INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, priority)
);

CREATE TABLE reservation_invitations (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES reservation_tasks(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(id),
  invitee_user_id TEXT REFERENCES users(id),
  invitee_student_id TEXT NOT NULL,
  invitee_real_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'AUTO_APPROVED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'USED')),
  approval_source TEXT NOT NULL CHECK (approval_source IN ('MANUAL', 'AUTO_AUTHORIZATION')),
  action_token_hash TEXT,
  expires_at INTEGER,
  responded_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES reservation_tasks(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  official_reservation_id TEXT,
  room_id INTEGER NOT NULL,
  room_name_snapshot TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  member_snapshot_json TEXT NOT NULL,
  submission_type TEXT NOT NULL CHECK (submission_type IN ('MANUAL', 'AUTO')),
  status TEXT NOT NULL,
  official_response_json_redacted TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX reservations_owner_date_idx ON reservations(owner_user_id, date);

CREATE TABLE sign_tasks (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WAITING_PARAMETERS', 'READY', 'DISABLED', 'SUCCESS', 'FAILED')),
  system_mac_ciphertext TEXT,
  qr_check_code_ciphertext TEXT,
  parameter_received_at INTEGER,
  executed_at INTEGER,
  official_response_redacted TEXT
);

CREATE TABLE signout_tasks (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  official_reservation_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUBMITTING', 'SUCCESS', 'FAILED', 'DISABLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  executed_at INTEGER,
  official_response_redacted TEXT
);

CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  template TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'ADMIN', 'SYSTEM')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  result TEXT NOT NULL,
  metadata_redacted_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);
