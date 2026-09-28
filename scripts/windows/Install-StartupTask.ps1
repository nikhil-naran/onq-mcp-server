. "$PSScriptRoot\Common.ps1"
if (!(Test-Path (Join-Path $OnqData 'tunnel-key.xml'))) { throw 'Run Configure-Tunnel.ps1 first.' }
$name = 'OnQ ChatGPT'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'OnQ ChatGPT task already exists. Remove it explicitly before replacing it.' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$start = Join-Path $PSScriptRoot 'Start-Tunnel.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -File "{0}"' -f $start) -WorkingDirectory $OnqProject
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host 'Installed OnQ ChatGPT startup task. Start it with: Start-ScheduledTask -TaskName "OnQ ChatGPT"'
Write-Host 'After reboot, sign in to this Windows account. Keep the machine awake; locking the screen is fine for existing sessions.'
