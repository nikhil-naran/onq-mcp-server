$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OnqProject = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$OnqData = Join-Path $env:LOCALAPPDATA 'OnQMCP'
$OnqConfig = Join-Path $OnqData 'config.yaml'
$env:ONQ_DATA_DIR = $OnqData
$env:BRIGHTSPACE_NO_UPDATE_CHECK = '1'
function Assert-OnqExit([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}
