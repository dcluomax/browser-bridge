<#
.SYNOPSIS
  Builds and installs the Browser Bridge Rust native host / MCP server and browser extensions
  for the current Windows user in one command.

.DESCRIPTION
  1. Builds the extension for Chromium (Edge/Chrome/Brave) and Firefox into extension\dist.
  2. Compiles the standalone Rust release binary (BrowserBridge.exe).
  3. Installs BrowserBridge.exe to %LOCALAPPDATA%\BrowserBridge\app and registers native messaging
     hosts under HKCU for Edge, Chrome, Chromium, and Firefox.
  4. Copies unpacked extensions to %LOCALAPPDATA%\BrowserBridge\extension so repository rebuilds
     never disrupt active browser profiles.
  5. Optionally registers the MCP server for GitHub Copilot, Claude Desktop, and/or Cursor,
     and optionally installs the zero-dependency Python SDK.

.EXAMPLE
  .\scripts\install.ps1 -RegisterCopilotMcp

.EXAMPLE
  .\scripts\install.ps1 -RegisterAllMcp -InstallPythonSdk
#>
[CmdletBinding()]
param(
    [switch]$RegisterCopilotMcp,
    [switch]$RegisterClaudeMcp,
    [switch]$RegisterCursorMcp,
    [switch]$RegisterAllMcp,
    [switch]$InstallPythonSdk,
    [switch]$ReadOnlyMcp,
    [switch]$AllowEvaluate,
    [switch]$SkipExtensionBuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $repo 'extension'
$rustDir = Join-Path $repo 'rust'
$appDir = Join-Path $env:LOCALAPPDATA 'BrowserBridge\app'
$config = Get-Content (Join-Path $extension 'bridge.config.json') -Raw | ConvertFrom-Json

if ($RegisterAllMcp) {
    $RegisterCopilotMcp = $true
    $RegisterClaudeMcp = $true
    $RegisterCursorMcp = $true
}

if (-not $SkipExtensionBuild) {
    Push-Location $extension
    try {
        if (-not (Test-Path 'node_modules')) { npm ci --no-fund --no-audit | Out-Host }
        node build.mjs | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Extension build failed.' }
    } finally { Pop-Location }
}

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$vcvarsName = if ($arch -eq 'Arm64') { 'vcvarsarm64.bat' } else { 'vcvars64.bat' }
$vcvars = Get-ChildItem "C:\Program Files*\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\$vcvarsName" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if ($vcvars) {
    & $env:ComSpec /c "call `"$vcvars`" >nul && cd /d `"$rustDir`" && cargo build --release -p browser-bridge" | Out-Host
} else {
    Push-Location $rustDir
    try { cargo build --release -p browser-bridge | Out-Host } finally { Pop-Location }
}
if ($LASTEXITCODE -ne 0) { throw 'Rust release build failed.' }

$hostBin = Join-Path $rustDir 'target\release\BrowserBridge.exe'

# Browsers reconnect automatically; stop matching running hosts right before replacing the binary.
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $running = Get-CimInstance Win32_Process -Filter "Name = 'BrowserBridge.exe'" |
        Where-Object { $_.ExecutablePath -eq (Join-Path $appDir 'BrowserBridge.exe') }
    foreach ($process in $running) {
        $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($live) {
            Write-Host "Stopping running host process $($process.ProcessId)"
            Stop-Process -Id $process.ProcessId -Force
            if (-not $live.WaitForExit(5000)) { throw "Host process $($process.ProcessId) did not exit." }
        }
    }
    try {
        Copy-Item -LiteralPath $hostBin -Destination (Join-Path $appDir 'BrowserBridge.exe') -Force
        break
    } catch [System.IO.IOException], [System.UnauthorizedAccessException] {
        if ($attempt -eq 3) { throw }
        Write-Warning "A host reconnected while files were copied; retrying installation ($attempt/3)."
        Start-Sleep -Milliseconds 100
    }
}

$exe = Join-Path $appDir 'BrowserBridge.exe'
& $exe install --chromium-id $config.chromiumExtensionId --gecko-id $config.geckoId --host-path $exe | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Native host registration failed.' }

# Browsers load the extension from a stable copy so rebuilding the repository never breaks them.
$extensionHome = Join-Path $env:LOCALAPPDATA 'BrowserBridge\extension'
foreach ($target in 'chromium', 'firefox') {
    robocopy (Join-Path $extension "dist\$target") (Join-Path $extensionHome $target) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying the $target extension failed (robocopy $LASTEXITCODE)." }
}
$global:LASTEXITCODE = 0

function Register-McpJsonConfig {
    param(
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)][pscustomobject]$ServerEntry,
        [Parameter(Mandatory)][string]$ClientLabel
    )
    $parent = Split-Path -Parent $ConfigPath
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $doc = if (Test-Path $ConfigPath) { Get-Content $ConfigPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{ mcpServers = [pscustomobject]@{} } }
    if (-not $doc.mcpServers) { $doc | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
    $doc.mcpServers | Add-Member -NotePropertyName 'browser-bridge' -NotePropertyValue $ServerEntry -Force
    ($doc | ConvertTo-Json -Depth 10) | Set-Content $ConfigPath -Encoding utf8
    Write-Host "Registered MCP server 'browser-bridge' for $ClientLabel in $ConfigPath"
}

$mcpArgs = @('mcp')
if ($ReadOnlyMcp) { $mcpArgs += '--read-only' }
if ($AllowEvaluate) { $mcpArgs += '--allow-evaluate' }

if ($RegisterCopilotMcp) {
    $copilotEntry = [pscustomobject]@{ type = 'local'; command = $exe; args = $mcpArgs; tools = @('*') }
    Register-McpJsonConfig -ConfigPath (Join-Path $HOME '.copilot\mcp-config.json') -ServerEntry $copilotEntry -ClientLabel 'GitHub Copilot'
}

if ($RegisterClaudeMcp) {
    $claudeEntry = [pscustomobject]@{ command = $exe; args = $mcpArgs }
    Register-McpJsonConfig -ConfigPath (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json') -ServerEntry $claudeEntry -ClientLabel 'Claude Desktop'
}

if ($RegisterCursorMcp) {
    $cursorEntry = [pscustomobject]@{ command = $exe; args = $mcpArgs }
    Register-McpJsonConfig -ConfigPath (Join-Path $HOME '.cursor\mcp.json') -ServerEntry $cursorEntry -ClientLabel 'Cursor'
}

if ($InstallPythonSdk) {
    python -m pip install (Join-Path $repo 'python') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Python SDK installation failed.' }
}

Write-Host ''
Write-Host 'Browser Bridge installed successfully!' -ForegroundColor Green
Write-Host 'Load the extension once per browser profile (afterwards click Reload on the extension card after updates):'
Write-Host "  Edge:    edge://extensions   -> Developer mode -> Load unpacked -> $extensionHome\chromium"
Write-Host "  Chrome:  chrome://extensions -> Developer mode -> Load unpacked -> $extensionHome\chromium"
Write-Host "  Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> $extensionHome\firefox\manifest.json"
Write-Host "           (permanent install needs a signed XPI: npm --prefix extension run sign:firefox)"
Write-Host "Expected Chromium extension id: $($config.chromiumExtensionId)"
Write-Host "Native host & MCP server:       $exe"
Write-Host "Verify connection status with:  `"$exe`" status"
