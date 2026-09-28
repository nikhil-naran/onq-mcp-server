. "$PSScriptRoot\Common.ps1"
$env:ONQ_TOOL_PROFILE = 'coursework'
$tunnel = (Get-Content (Join-Path $OnqData 'tunnel-path.txt') -Raw).Trim()
$key = Import-Clixml (Join-Path $OnqData 'tunnel-key.xml')
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
try {
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    & $tunnel run --profile onq
    Assert-OnqExit 'Tunnel runtime'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
}
