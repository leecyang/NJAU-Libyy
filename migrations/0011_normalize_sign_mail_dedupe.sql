CREATE TEMP TABLE sign_mail_dedupe_candidates AS
SELECT
  email.id,
  email.status,
  email.created_at,
  CASE email.template
    WHEN 'AUTO_SIGN_SUCCESS' THEN 'auto-sign:'
    WHEN 'AUTO_SIGN_FAILED' THEN 'auto-sign:'
    WHEN 'AUTO_SIGNOUT_SUCCESS' THEN 'auto-signout:'
    WHEN 'AUTO_SIGNOUT_FAILED' THEN 'auto-signout:'
  END || workflow.room_id || ':' || workflow.date || ':' || workflow.start_time || ':' || workflow.end_time || ':' ||
  CASE
    WHEN email.template IN ('AUTO_SIGN_SUCCESS', 'AUTO_SIGNOUT_SUCCESS') THEN 'success:'
    ELSE 'failed:'
  END || user.id AS normalized_key,
  ROW_NUMBER() OVER (
    PARTITION BY
      email.template,
      email.recipient_email,
      workflow.room_id,
      workflow.date,
      workflow.start_time,
      workflow.end_time
    ORDER BY
      CASE email.status WHEN 'SENT' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
      email.created_at,
      email.id
  ) AS duplicate_rank
FROM email_outbox email
JOIN users user ON lower(user.email) = lower(email.recipient_email)
JOIN sign_workflows workflow ON (
  email.dedupe_key LIKE 'auto-sign:' || workflow.id || ':%'
  OR email.dedupe_key LIKE 'auto-signout:' || workflow.id || ':%'
)
WHERE email.template IN (
  'AUTO_SIGN_SUCCESS',
  'AUTO_SIGN_FAILED',
  'AUTO_SIGNOUT_SUCCESS',
  'AUTO_SIGNOUT_FAILED'
);

UPDATE email_outbox
SET dedupe_key = NULL
WHERE id IN (SELECT id FROM sign_mail_dedupe_candidates);

UPDATE email_outbox
SET
  status = 'FAILED',
  next_attempt_at = NULL,
  delivery_lock_until = NULL,
  last_error_message = 'DUPLICATE_NOTIFICATION_SUPPRESSED'
WHERE status = 'PENDING'
  AND id IN (
    SELECT id FROM sign_mail_dedupe_candidates WHERE duplicate_rank > 1
  );

UPDATE email_outbox
SET dedupe_key = (
  SELECT normalized_key
  FROM sign_mail_dedupe_candidates candidate
  WHERE candidate.id = email_outbox.id
)
WHERE id IN (
  SELECT id FROM sign_mail_dedupe_candidates WHERE duplicate_rank = 1
);

DROP TABLE sign_mail_dedupe_candidates;
