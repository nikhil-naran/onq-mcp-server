param([Parameter(Mandatory=$true)][ValidatePattern('^tunnel_[A-Za-z0-9]+$')][string]$TunnelId)
. "$PSScriptRoot\Common.ps1"
if (!(Test-Path $OnqConfig)) { throw 'Run Setup-OnQ.ps1 first.' }
$tunnel = (Get-Command tunnel-client.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $OnqProject 'build\cli\main.js'
$command = '"{0}" "{1}" serve --config "{2}" --profile onq' -f $node, $entry, $OnqConfig
$key = Read-Host 'OpenAI Platform runtime API key for the tunnel (stored encrypted for this Windows user)' -AsSecureString
$key | Export-Clixml (Join-Path $OnqData 'tunnel-key.xml')
$tunnel | Set-Content (Join-Path $OnqData 'tunnel-path.txt')
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
try {
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    & $tunnel init --sample sample_mcp_stdio_local --profile onq --tunnel-id $TunnelId --mcp-command $command
    Assert-OnqExit 'Initializing tunnel profile'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
}
Write-Host 'Tunnel profile prepared. Run Start-Tunnel.ps1 and check its connection before enabling startup.'
