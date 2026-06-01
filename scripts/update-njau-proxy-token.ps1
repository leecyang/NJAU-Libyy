param(
  [string]$Repository = "leecyang/NJAU-Libyy"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "_secret-upload-utils.ps1")

$njauProxyToken = Normalize-Secret (Read-PlainSecret "NJAU_PROXY_TOKEN")

try {
  foreach ($environment in @("staging", "production")) {
    Set-GitHubSecret -Repository $Repository -Environment $environment -Name "NJAU_PROXY_TOKEN" -Value $njauProxyToken
  }

  $wranglerUploaded = $true
  foreach ($environment in @("staging", "production")) {
    try {
      Set-WranglerSecret -Environment $environment -Name "NJAU_PROXY_TOKEN" -Value $njauProxyToken
    } catch {
      $wranglerUploaded = $false
      Write-Warning "Direct Wrangler upload failed. GitHub Actions will apply NJAU_PROXY_TOKEN during deployment."
      break
    }
  }

  if ($wranglerUploaded) {
    Write-Host "NJAU proxy token uploaded to GitHub environments and Wrangler without echoing its value."
  } else {
    Write-Host "NJAU proxy token uploaded to GitHub environments without echoing its value."
  }
} finally {
  Remove-Variable njauProxyToken -ErrorAction SilentlyContinue
}
