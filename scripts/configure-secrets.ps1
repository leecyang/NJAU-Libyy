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

function Set-EnvironmentSecret {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )
  foreach ($environment in @("staging", "production")) {
    $Value | gh secret set $Name --env $environment --repo $Repository
    $Value | npx wrangler secret put $Name --env $environment
  }
}

$libyyAppSecret = Read-PlainSecret "LIBYY_APP_SECRET"
$smtpPassword = Read-PlainSecret "SMTP_PASSWORD"
$cloudflareApiToken = Read-PlainSecret "CLOUDFLARE_API_TOKEN"

try {
  Set-EnvironmentSecret -Name "LIBYY_APP_SECRET" -Value $libyyAppSecret
  Set-EnvironmentSecret -Name "SMTP_PASSWORD" -Value $smtpPassword
  $cloudflareApiToken | gh secret set CLOUDFLARE_API_TOKEN --repo $Repository
  Write-Host "Secrets uploaded without echoing their values."
} finally {
  Remove-Variable libyyAppSecret, smtpPassword, cloudflareApiToken -ErrorAction SilentlyContinue
}

