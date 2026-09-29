. "$PSScriptRoot\Common.ps1"
$settings = Get-Content (Join-Path $OnqData 'downloads\settings.json') -Raw | ConvertFrom-Json
Write-Host 'This serves only a synthetic PDF. Stop it before starting OnQ in download mode (same port).'
& node.exe (Join-Path $OnqProject 'scripts\download-probe.mjs') "https://$($settings.hostname)" $settings.port
Assert-OnqExit 'Synthetic PDF download probe'
