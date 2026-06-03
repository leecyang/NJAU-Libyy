param(
  [string]$Repository = "leecyang/NJAU-Libyy"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "_secret-upload-utils.ps1")

$njauProxyToken = Normalize-Secret (Read-PlainSecret "NJAU_PROXY_TOKEN")

try {
  Set-GitHubSecret -Repository $Repository -Environment "production" -Name "NJAU_PROXY_TOKEN" -Value $njauProxyToken

  $wranglerUploaded = $true
  try {
    Set-WranglerSecret -Environment "production" -Name "NJAU_PROXY_TOKEN" -Value $njauProxyToken
  } catch {
    $wranglerUploaded = $false
    Write-Warning "Direct Wrangler upload failed. GitHub Actions will apply NJAU_PROXY_TOKEN during deployment."
  }

  if ($wranglerUploaded) {
    Write-Host "NJAU proxy token uploaded to the production GitHub environment and Wrangler without echoing its value."
  } else {
    Write-Host "NJAU proxy token uploaded to the production GitHub environment without echoing its value."
  }
} finally {
  Remove-Variable njauProxyToken -ErrorAction SilentlyContinue
}
