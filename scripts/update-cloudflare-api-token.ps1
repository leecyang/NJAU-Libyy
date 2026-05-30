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

$cloudflareApiToken = (Read-PlainSecret "CLOUDFLARE_API_TOKEN").Trim().TrimStart([char]0xFEFF)

try {
  $cloudflareApiToken | gh secret set CLOUDFLARE_API_TOKEN --repo $Repository
  Write-Host "Cloudflare API token uploaded without echoing its value."
} finally {
  Remove-Variable cloudflareApiToken -ErrorAction SilentlyContinue
}
