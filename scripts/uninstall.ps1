<#
.SYNOPSIS
  Unregisters Browser Bridge native messaging manifests and optionally removes installed files.
#>
[CmdletBinding()]
param(
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
$baseDir = Join-Path $env:LOCALAPPDATA 'BrowserBridge'
$exe = Join-Path $baseDir 'app\BrowserBridge.exe'

if (Test-Path $exe) {
    & $exe uninstall | Out-Host
}

$running = Get-CimInstance Win32_Process -Filter "Name = 'BrowserBridge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $exe }
foreach ($proc in $running) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

if ($PurgeData -and (Test-Path $baseDir)) {
    Remove-Item -LiteralPath $baseDir -Recurse -Force
    Write-Host "Removed $baseDir"
}

Write-Host 'Browser Bridge native host unregistered. Remove the unpacked extension in your browser and delete any MCP config entry if no longer needed.'
