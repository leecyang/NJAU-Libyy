CREATE TABLE reservation_member_acceptance_tasks (
  id TEXT PRIMARY KEY,
  reservation_id TEXT REFERENCES reservations(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  official_reservation_id TEXT NOT NULL,
  room_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'DISABLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(member_user_id, official_reservation_id)
);

CREATE INDEX reservation_member_acceptance_due_idx
  ON reservation_member_acceptance_tasks(status, next_attempt_at, updated_at);

CREATE INDEX reservation_member_acceptance_owner_idx
  ON reservation_member_acceptance_tasks(owner_user_id, status, updated_at);
