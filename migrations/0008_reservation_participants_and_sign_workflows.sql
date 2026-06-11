ALTER TABLE reservation_tasks ADD COLUMN requested_by_user_id TEXT REFERENCES users(id);
UPDATE reservation_tasks SET requested_by_user_id = owner_user_id WHERE requested_by_user_id IS NULL;

ALTER TABLE reservation_task_members ADD COLUMN participant_order INTEGER NOT NULL DEFAULT 1;

ALTER TABLE reservations ADD COLUMN requested_by_user_id TEXT REFERENCES users(id);
UPDATE reservations SET requested_by_user_id = owner_user_id WHERE requested_by_user_id IS NULL;

CREATE TABLE sign_workflows (
  id TEXT PRIMARY KEY,
  reservation_id TEXT REFERENCES reservations(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  anchor_user_id TEXT NOT NULL REFERENCES users(id),
  official_reservation_id TEXT NOT NULL,
  room_id INTEGER NOT NULL,
  room_name_snapshot TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  sign_advance_minutes INTEGER NOT NULL DEFAULT 15 CHECK (sign_advance_minutes BETWEEN 0 AND 60),
  signout_advance_minutes INTEGER NOT NULL DEFAULT 10 CHECK (signout_advance_minutes BETWEEN 0 AND 60),
  sign_scheduled_at INTEGER NOT NULL,
  signout_scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUCCESS', 'FAILED', 'CANCELLED', 'DISABLED')),
  signout_status TEXT NOT NULL CHECK (signout_status IN ('PENDING', 'SUBMITTING', 'SUCCESS', 'FAILED', 'DISABLED')),
  signout_user_id TEXT REFERENCES users(id),
  signout_attempt_count INTEGER NOT NULL DEFAULT 0,
  signout_executed_at INTEGER,
  failure_code TEXT,
  failure_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX sign_workflows_reservation_idx
  ON sign_workflows(reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX sign_workflows_due_idx
  ON sign_workflows(status, sign_scheduled_at, signout_scheduled_at);
CREATE INDEX sign_workflows_requester_idx
  ON sign_workflows(requested_by_user_id, created_at DESC);

CREATE TABLE sign_workflow_participants (
  workflow_id TEXT NOT NULL REFERENCES sign_workflows(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  participant_order INTEGER NOT NULL,
  sign_status TEXT NOT NULL CHECK (sign_status IN ('PENDING', 'SUBMITTING', 'SUCCESS', 'FAILED', 'DISABLED')),
  sign_attempt_count INTEGER NOT NULL DEFAULT 0,
  signed_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, user_id),
  UNIQUE(workflow_id, participant_order)
);

CREATE INDEX sign_workflow_participants_due_idx
  ON sign_workflow_participants(workflow_id, sign_status, participant_order);
