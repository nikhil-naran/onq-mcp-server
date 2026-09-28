. "$PSScriptRoot\Common.ps1"
if (!(Test-Path $OnqConfig)) { throw 'Run Setup-OnQ.ps1 first.' }
Write-Host 'If the tunnel is using the browser, stop the OnQ ChatGPT task before signing in.'
& node.exe (Join-Path $OnqProject 'build\cli\main.js') auth --config $OnqConfig --profile onq
Assert-OnqExit 'OnQ sign-in'
