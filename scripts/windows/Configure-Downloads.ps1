param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])$')][string]$Hostname,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$')][string]$TunnelId,
    [Parameter(Mandatory=$true)][string]$CredentialsFile,
    [ValidateRange(1024,65535)][int]$Port = 8766,
    [switch]$EnableDownloads
)
. "$PSScriptRoot\Common.ps1"
if (!(Test-Path $OnqConfig)) { throw 'Run Setup-OnQ.ps1 first.' }
$cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
$credentials = Get-Content -LiteralPath $CredentialsFile -Raw | ConvertFrom-Json
if ($credentials.TunnelID -ne $TunnelId) { throw 'The credentials file belongs to a different tunnel.' }
$downloadDir = Join-Path $OnqData 'downloads'
New-Item -ItemType Directory -Force $downloadDir | Out-Null
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $downloadDir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
Assert-OnqExit 'Restricting download configuration access'
$savedCredentials = Join-Path $downloadDir 'credentials.json'
if (([IO.Path]::GetFullPath($CredentialsFile)) -ne ([IO.Path]::GetFullPath($savedCredentials))) {
    Copy-Item -LiteralPath $CredentialsFile -Destination $savedCredentials
}
# JSON is valid YAML; serialization avoids quoting/injection problems in Windows paths.
$settings = [ordered]@{
    tunnel = $TunnelId
    'credentials-file' = $savedCredentials
    ingress = @(
        [ordered]@{ hostname = $Hostname; path = '^/files/[a-f0-9]{64}/[^/?]+$'; service = "http://127.0.0.1:$Port" },
        [ordered]@{ service = 'http_status:404' }
    )
}
$settings | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $downloadDir 'cloudflared.yml')
& $cloudflared tunnel --config (Join-Path $downloadDir 'cloudflared.yml') ingress validate
Assert-OnqExit 'Validating download-only ingress'
$cloudflared | Set-Content (Join-Path $downloadDir 'cloudflared-path.txt')
@{ hostname = $Hostname; port = $Port; tunnel_id = $TunnelId } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $downloadDir 'settings.json')
if ($EnableDownloads) {
    & node.exe (Join-Path $OnqProject 'scripts\configure-downloads.mjs') $OnqConfig "https://$Hostname" $Port
    Assert-OnqExit 'Enabling original-file download links'
    Write-Host 'Download mode enabled. Stop the synthetic probe, then restart the OnQ MCP task.'
} else {
    Write-Host 'Prepared download tunnel only; OnQ delivery is unchanged. Test with Start-DownloadProbe.ps1 first.'
}
Write-Host 'Create the DNS route for this hostname using cloudflared tunnel route dns, then run Start-DownloadTunnel.ps1.'
