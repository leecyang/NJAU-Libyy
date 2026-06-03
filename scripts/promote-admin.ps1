param(
  [ValidateSet("production")]
  [string]$Environment = "production",

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[^@\s]+@[^@\s]+\.[^@\s]+$")]
  [string]$Email
)

$ErrorActionPreference = "Stop"
$escapedEmail = $Email.Replace("'", "''").ToLowerInvariant()
$sql = "UPDATE users SET role = 'ADMIN', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE lower(email) = '$escapedEmail' AND status = 'ACTIVE'; SELECT id, email, role, status FROM users WHERE lower(email) = '$escapedEmail';"

npx wrangler d1 execute DB --env $Environment --remote --command $sql
