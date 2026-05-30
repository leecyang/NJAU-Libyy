param(
  [string]$Repository = "leecyang/NJAU-Libyy"
)

$ErrorActionPreference = "Stop"

function Read-PlainSecret {
  param([Parameter(Mandatory = $true)][string]$Prompt)
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Normalize-Secret {
  param([Parameter(Mandatory = $true)][string]$Value)
  return $Value.Trim().TrimStart([char]0xFEFF)
}

$smtpPassword = Normalize-Secret (Read-PlainSecret "SMTP_PASSWORD (Alibaba enterprise email third-party client security password)")

try {
  foreach ($environment in @("staging", "production")) {
    $smtpPassword | gh secret set SMTP_PASSWORD --env $environment --repo $Repository
    $smtpPassword | npx wrangler secret put SMTP_PASSWORD --env $environment
    npx wrangler d1 execute DB --env $environment --remote --command @"
UPDATE email_outbox
   SET status = 'PENDING',
       attempt_count = 0,
       next_attempt_at = 0,
       delivery_lock_until = NULL,
       last_error_message = NULL
 WHERE status IN ('PENDING', 'FAILED');
"@
  }
  $smtpPassword | gh secret set SMTP_PASSWORD --repo $Repository
  Write-Host "SMTP password uploaded without echoing its value. Pending email delivery will retry on the next Cron run."
} finally {
  Remove-Variable smtpPassword -ErrorAction SilentlyContinue
}
