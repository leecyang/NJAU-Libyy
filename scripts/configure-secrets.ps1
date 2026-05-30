param(
  [string]$Repository = "leecyang/NJAU-Libyy"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "_secret-upload-utils.ps1")

function Set-EnvironmentSecret {
  param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )
  foreach ($environment in @("staging", "production")) {
    Set-GitHubSecret -Repository $Repository -Environment $environment -Name $Name -Value $Value
    Set-WranglerSecret -Environment $environment -Name $Name -Value $Value
  }
}

$libyyAppSecret = Normalize-Secret (Read-PlainSecret "LIBYY_APP_SECRET")
$smtpPassword = Normalize-Secret (Read-PlainSecret "SMTP_PASSWORD")
$cloudflareApiToken = Normalize-Secret (Read-PlainSecret "CLOUDFLARE_API_TOKEN")

try {
  Set-EnvironmentSecret -Repository $Repository -Name "LIBYY_APP_SECRET" -Value $libyyAppSecret
  Set-EnvironmentSecret -Repository $Repository -Name "SMTP_PASSWORD" -Value $smtpPassword
  Set-GitHubSecret -Repository $Repository -Name "CLOUDFLARE_API_TOKEN" -Value $cloudflareApiToken
  Write-Host "Secrets uploaded without echoing their values."
} finally {
  Remove-Variable libyyAppSecret, smtpPassword, cloudflareApiToken -ErrorAction SilentlyContinue
}
