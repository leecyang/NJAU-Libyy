ALTER TABLE users ADD COLUMN official_user_internal_id INTEGER;
ALTER TABLE users ADD COLUMN official_mobile_ciphertext TEXT;

ALTER TABLE reservations ADD COLUMN official_status INTEGER;
ALTER TABLE reservations ADD COLUMN synced_at INTEGER;

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  leader_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members(user_id, joined_at DESC);

CREATE TABLE team_invitations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(id),
  invitee_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  action_token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX team_invitations_invitee_idx ON team_invitations(invitee_user_id, status, created_at DESC);
CREATE INDEX team_invitations_expiry_idx ON team_invitations(status, expires_at);

CREATE TABLE recent_contacts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  official_student_id TEXT NOT NULL,
  official_real_name TEXT NOT NULL,
  last_used_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_user_id, official_student_id)
);
CREATE INDEX recent_contacts_owner_idx ON recent_contacts(owner_user_id, last_used_at DESC);

CREATE TABLE reservation_task_members (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES reservation_tasks(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('TEAM', 'CONTACT')),
  member_user_id TEXT REFERENCES users(id),
  contact_id TEXT REFERENCES recent_contacts(id),
  official_student_id TEXT NOT NULL,
  official_real_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, official_student_id)
);

