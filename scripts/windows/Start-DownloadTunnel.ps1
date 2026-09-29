. "$PSScriptRoot\Common.ps1"
$downloadDir = Join-Path $OnqData 'downloads'
$cloudflared = (Get-Content (Join-Path $downloadDir 'cloudflared-path.txt') -Raw).Trim()
$config = Join-Path $downloadDir 'cloudflared.yml'
if (!(Test-Path $config)) { throw 'Run Configure-Downloads.ps1 first.' }
# No secrets in arguments; only this dedicated download listener is exposed.
& $cloudflared tunnel --config $config run
Assert-OnqExit 'Download reverse tunnel'
