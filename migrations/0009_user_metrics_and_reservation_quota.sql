CREATE TABLE reservation_quota_claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reservation_date TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  source_type TEXT NOT NULL CHECK (source_type IN ('TASK', 'RESERVATION', 'MANUAL')),
  source_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, reservation_date, slot),
  UNIQUE(user_id, reservation_date, source_type, source_id)
);

CREATE INDEX reservation_quota_claims_source_idx
  ON reservation_quota_claims(source_type, source_id);

CREATE INDEX reservation_quota_claims_date_idx
  ON reservation_quota_claims(reservation_date, user_id);
