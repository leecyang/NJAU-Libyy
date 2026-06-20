CREATE TEMP TABLE _bootstrap_first_admin_user AS
SELECT id, email
FROM users
WHERE status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE role = 'ADMIN'
  )
ORDER BY created_at ASC
LIMIT 1;

UPDATE users
SET role = 'ADMIN',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id IN (
  SELECT id
  FROM _bootstrap_first_admin_user
);

INSERT INTO audit_logs
  (id, actor_user_id, actor_type, action, target_type, target_id, result, metadata_redacted_json, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-' ||
  '4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  id,
  'SYSTEM',
  'BOOTSTRAP_FIRST_ADMIN',
  'USER',
  id,
  'SUCCESS',
  json_object('email', email, 'source', '0012_bootstrap_first_admin'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM _bootstrap_first_admin_user;

DROP TABLE _bootstrap_first_admin_user;
