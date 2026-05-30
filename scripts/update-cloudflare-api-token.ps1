param(
  [string]$Repository = "leecyang/NJAU-Libyy"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "_secret-upload-utils.ps1")

$cloudflareApiToken = Normalize-Secret (Read-PlainSecret "CLOUDFLARE_API_TOKEN")

try {
  Set-GitHubSecret -Repository $Repository -Name "CLOUDFLARE_API_TOKEN" -Value $cloudflareApiToken
  Write-Host "Cloudflare API token uploaded without echoing its value."
} finally {
  Remove-Variable cloudflareApiToken -ErrorAction SilentlyContinue
}
