ALTER TABLE sign_tasks RENAME TO sign_tasks_legacy;

CREATE TABLE sign_tasks (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUBMITTING', 'DISABLED', 'SUCCESS', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  executed_at INTEGER,
  official_response_redacted TEXT
);

INSERT INTO sign_tasks (
  id, reservation_id, scheduled_at, status, attempt_count, executed_at, official_response_redacted
)
SELECT
  id,
  reservation_id,
  scheduled_at,
  CASE
    WHEN status = 'SUCCESS' THEN 'SUCCESS'
    WHEN status = 'FAILED' THEN 'FAILED'
    WHEN status = 'DISABLED' THEN 'DISABLED'
    ELSE 'PENDING'
  END,
  0,
  executed_at,
  official_response_redacted
FROM sign_tasks_legacy;

DROP TABLE sign_tasks_legacy;

CREATE INDEX sign_tasks_due_idx ON sign_tasks(status, scheduled_at);
