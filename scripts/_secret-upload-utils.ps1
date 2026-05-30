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
  return $Value.Trim().TrimStart([char]0xFEFF).Trim()
}

function Invoke-SecretCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $command = Get-Command $Executable -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.StandardInputEncoding = [Text.UTF8Encoding]::new($false)

  if ([IO.Path]::GetExtension($command.Source) -in @(".cmd", ".bat")) {
    $startInfo.FileName = (Get-Command "cmd.exe" -CommandType Application -ErrorAction Stop).Source
    $escapedArguments = $ArgumentList | ForEach-Object { '"' + $_.Replace('"', '""') + '"' }
    $startInfo.Arguments = '/d /s /c ""' + $command.Source + '" ' + ($escapedArguments -join " ") + '"'
  } else {
    $startInfo.FileName = $command.Source
    foreach ($argument in $ArgumentList) {
      $startInfo.ArgumentList.Add($argument)
    }
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (!$process.Start()) {
      throw "Failed to start $Executable"
    }
    $process.StandardInput.Write($Value)
    $process.StandardInput.Close()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "$Executable exited with code $($process.ExitCode)"
    }
  } finally {
    $process.Dispose()
  }
}

function Set-GitHubSecret {
  param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value,
    [string]$Environment
  )
  $arguments = @("secret", "set", $Name, "--repo", $Repository)
  if ($Environment) {
    $arguments += @("--env", $Environment)
  }
  Invoke-SecretCommand -Executable "gh" -ArgumentList $arguments -Value $Value
}

function Set-WranglerSecret {
  param(
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )
  Invoke-SecretCommand -Executable "npx" -ArgumentList @("wrangler", "secret", "put", $Name, "--env", $Environment) -Value $Value
}
