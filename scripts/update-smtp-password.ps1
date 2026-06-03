param(
  [string]$Repository = "leecyang/NJAU-Libyy"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "_secret-upload-utils.ps1")

$smtpPassword = Normalize-Secret (Read-PlainSecret "SMTP_PASSWORD (Alibaba enterprise email third-party client security password)")

try {
  Set-GitHubSecret -Repository $Repository -Environment "production" -Name "SMTP_PASSWORD" -Value $smtpPassword
  Set-WranglerSecret -Environment "production" -Name "SMTP_PASSWORD" -Value $smtpPassword
  npx wrangler d1 execute DB --env production --remote --command @"
UPDATE email_outbox
   SET status = 'PENDING',
       attempt_count = 0,
       next_attempt_at = 0,
       delivery_lock_until = NULL,
       last_error_message = NULL
 WHERE status IN ('PENDING', 'FAILED');
"@
  Write-Host "SMTP password uploaded without echoing its value. Pending email delivery will retry on the next Cron run."
} finally {
  Remove-Variable smtpPassword -ErrorAction SilentlyContinue
}
