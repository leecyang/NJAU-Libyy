CREATE TABLE official_gateway_snapshots (
  cache_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'USER')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  fresh_until INTEGER NOT NULL,
  stale_until INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  refresh_job_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope = 'GLOBAL' AND owner_user_id IS NULL) OR (scope = 'USER' AND owner_user_id IS NOT NULL))
);

CREATE INDEX idx_official_gateway_snapshots_owner
  ON official_gateway_snapshots(owner_user_id, kind, updated_at DESC);

CREATE TABLE official_gateway_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('READ', 'WRITE', 'PLAYWRIGHT')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  priority INTEGER NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at INTEGER NOT NULL,
  locked_at INTEGER,
  lease_until INTEGER,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_official_gateway_jobs_dispatch
  ON official_gateway_jobs(status, available_at, priority, created_at);

CREATE INDEX idx_official_gateway_jobs_owner
  ON official_gateway_jobs(owner_user_id, created_at DESC);

CREATE UNIQUE INDEX idx_official_gateway_jobs_active_dedupe
  ON official_gateway_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING');
