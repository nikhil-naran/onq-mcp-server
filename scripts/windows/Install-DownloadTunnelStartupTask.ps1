. "$PSScriptRoot\Common.ps1"
if (!(Test-Path (Join-Path $OnqData 'downloads\cloudflared.yml'))) { throw 'Run Configure-Downloads.ps1 first.' }
$name = 'OnQ Downloads'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'OnQ Downloads task already exists. Remove it explicitly before replacing it.' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$start = Join-Path $PSScriptRoot 'Start-DownloadTunnel.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -File "{0}"' -f $start) -WorkingDirectory $OnqProject
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host 'Installed OnQ Downloads. Start it with: Start-ScheduledTask -TaskName "OnQ Downloads"'
Write-Host 'Both OnQ ChatGPT and OnQ Downloads must run in this Windows session. Keep Windows awake.'
