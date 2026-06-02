ALTER TABLE reservation_task_members RENAME TO reservation_task_members_legacy;

CREATE TABLE reservation_task_members (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES reservation_tasks(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('TEAM', 'CONTACT', 'AUTO_JOIN')),
  member_user_id TEXT REFERENCES users(id),
  contact_id TEXT REFERENCES recent_contacts(id),
  official_student_id TEXT NOT NULL,
  official_real_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, official_student_id)
);

INSERT INTO reservation_task_members (
  id,
  task_id,
  source,
  member_user_id,
  contact_id,
  official_student_id,
  official_real_name,
  created_at
)
SELECT
  id,
  task_id,
  source,
  member_user_id,
  contact_id,
  official_student_id,
  official_real_name,
  created_at
FROM reservation_task_members_legacy;

DROP TABLE reservation_task_members_legacy;
