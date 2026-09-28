. "$PSScriptRoot\Common.ps1"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$version = [version]((& $node --version).Trim().TrimStart('v'))
if ($version.Major -lt 22) { throw 'Install Node.js 24 LTS, then run this script again.' }
New-Item -ItemType Directory -Force $OnqData | Out-Null
# Protect browser tokens and private course caches with Windows ACLs.
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $OnqData /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
Assert-OnqExit 'Restricting data-directory access'
Push-Location $OnqProject
try {
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    Assert-OnqExit 'Installing locked dependencies'
    & node.exe node_modules/playwright/cli.js install chromium
    Assert-OnqExit 'Installing Chromium'
    & npm.cmd run build
    Assert-OnqExit 'Building server'
} finally { Pop-Location }
if (!(Test-Path $OnqConfig)) {
    $profileDir = (Join-Path $OnqData 'browser').Replace('\', '/') | ConvertTo-Json -Compress
    @"
default_profile: onq
profiles:
  onq:
    base_url: https://onq.queensu.ca
    auth:
      strategy: interactive
      interactive:
        profile_dir: $profileDir
        login_timeout_seconds: 120
        session_ttl_seconds: 3600
    session:
      cache_backend: memory
writes:
  enabled: false
output:
  tz: America/Toronto
  locale: en-US
  format: markdown
"@ | Set-Content -Encoding UTF8 $OnqConfig
}
Write-Host "Setup complete. Next run $PSScriptRoot\Login-OnQ.ps1"
