<#
.SYNOPSIS
  Installs a verified Browser Bridge package, or builds and installs one from this checkout.
.DESCRIPTION
  -PrebuiltPackage needs Python 3.11+ and does not need Node, npm, Rust, or Visual Studio.
  Browser and MCP targets are explicit. -FirefoxDevLauncher creates a dedicated-profile
  launcher without starting Firefox. No application is stopped, no profile is copied, and
  Firefox signing stays enabled.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Alias('HostOnly')][switch]$SkipDesktop,
    [Alias('PackagePath')][string]$PrebuiltPackage,
    [string]$Descriptor,
    [string]$PackageSha256,
    [string]$ExpectedVersion,
    [string]$InstallRoot,
    [string]$OutputDirectory,
    [ValidateSet('edge', 'chrome', 'chromium', 'firefox')][string[]]$Browsers = @('edge', 'chrome', 'chromium', 'firefox'),
    [ValidateSet('copilot', 'codex', 'claude')][string[]]$Agents = @(),
    [switch]$RegisterCopilotMcp,
    [switch]$RegisterCodexMcp,
    [switch]$RegisterClaudeMcp,
    [switch]$RegisterAllMcp,
    [switch]$InstallPythonSdk,
    [switch]$ReadOnlyMcp,
    [switch]$ReadWriteMcp,
    [switch]$AllowEvaluate,
    [switch]$DenyEvaluate,
    [string]$CopilotConfig,
    [string]$CodexConfig,
    [string]$ClaudeConfig,
    [switch]$SkipExtensionBuild,
    [string]$FirefoxXpi,
    [switch]$FirefoxDevLauncher,
    [string]$FirefoxExe,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$null = $SkipDesktop
$repo = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $PSScriptRoot 'distribution.py'
if ($ReadOnlyMcp -and $ReadWriteMcp) { throw 'Select either -ReadOnlyMcp or -ReadWriteMcp.' }
if ($AllowEvaluate -and $DenyEvaluate) { throw 'Select either -AllowEvaluate or -DenyEvaluate.' }
if ($ValidateOnly -and -not $PrebuiltPackage) { throw '-ValidateOnly requires -PrebuiltPackage.' }
if ($PrebuiltPackage -and $FirefoxXpi) { throw 'A prebuilt package cannot be modified with -FirefoxXpi.' }

$pythonCommand = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pythonCommand) { throw 'Python 3.11+ is required. Offline installation does not require Rust or Node.' }
$python = $pythonCommand.Source

function Invoke-Checked {
    param([string]$File, [string[]]$ArgumentList, [string]$Label)
    & $File @ArgumentList | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE). Nothing was force-stopped." }
}

Invoke-Checked $python @('-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)') 'Python 3.11+ check'
if (-not $InstallRoot) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required, or pass -InstallRoot.' }
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'BrowserBridge'
}

if ($RegisterAllMcp) {
    $RegisterCopilotMcp = $true
    $RegisterCodexMcp = $true
    $RegisterClaudeMcp = $true
}
if ($RegisterCopilotMcp) { $Agents += 'copilot' }
if ($RegisterCodexMcp) { $Agents += 'codex' }
if ($RegisterClaudeMcp) { $Agents += 'claude' }
$Agents = @($Agents | Select-Object -Unique)

if (-not $PrebuiltPackage) {
    if (-not $PSCmdlet.ShouldProcess($repo, 'Build a Browser Bridge package')) { return }
    $extension = Join-Path $repo 'extension'
    $rust = Join-Path $repo 'rust'
    if (-not $SkipExtensionBuild) {
        Push-Location $extension
        try {
            if (-not (Test-Path 'node_modules')) { npm ci --no-fund --no-audit | Out-Host }
            Invoke-Checked 'node' @('build.mjs', '--zip') 'Extension build (restore missing dependencies with npm ci, then retry)'
        } finally { Pop-Location }
    }
    $cargoCommand = Get-Command cargo -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $cargo = if ($cargoCommand) { $cargoCommand.Source } else {
        Join-Path $HOME '.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe'
    }
    if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) {
        throw 'A Rust toolchain is required for source builds. Use -PrebuiltPackage for offline installation.'
    }
    $toolBin = Split-Path -Parent $cargo
    $rustc = Join-Path $toolBin 'rustc.exe'
    if (-not (Test-Path -LiteralPath $rustc)) { throw "Cannot find rustc beside cargo: $toolBin" }
    $hostLines = & $rustc -vV
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the Rust compiler host target.' }
    $rustHost = @($hostLines | Where-Object { $_ -match '^host: ' })[0] -replace '^host: ', ''
    $architecture = if ($rustHost -eq 'aarch64-pc-windows-msvc') { 'aarch64' } elseif ($rustHost -eq 'x86_64-pc-windows-msvc') { 'x86_64' } else {
        throw "Unsupported Windows source build target: $rustHost"
    }
    $vcName = if ($architecture -eq 'aarch64') { 'vcvarsarm64.bat' } else { 'vcvars64.bat' }
    $vcvars = Get-ChildItem "C:\Program Files*\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\$vcName" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    if (-not $vcvars) {
        $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path -LiteralPath $vswhere) {
            $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
            if ($LASTEXITCODE -ne 0) { throw 'Visual Studio discovery failed.' }
            if ($vsRoot) { $vcvars = Join-Path $vsRoot "VC\Auxiliary\Build\$vcName" }
        }
    }
    if (-not $vcvars -or -not (Test-Path -LiteralPath $vcvars)) { throw 'Visual Studio C++ Build Tools are required, or use -PrebuiltPackage.' }
    foreach ($path in @($rust, $cargo, $toolBin, $vcvars)) {
        if ($path -match '["%&|<>^!\r\n]') { throw 'This source-build path cannot be safely passed to cmd.exe. Use a prebuilt package.' }
    }
    $buildCommand = "call `"$vcvars`" >nul && set `"PATH=$toolBin;%PATH%`" && cd /d `"$rust`" && `"$cargo`" build --locked --release -p browser-bridge"
    Invoke-Checked $env:ComSpec @('/d', '/s', '/c', $buildCommand) 'Rust release build'
    if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'dist' }
    $packageArgs = @($engine, 'pack', '--root', $repo, '--target', "windows-$architecture",
        '--native-binary', (Join-Path $rust 'target\release\BrowserBridge.exe'), '--output', $OutputDirectory)
    if ($FirefoxXpi) { $packageArgs += @('--firefox-xpi', $FirefoxXpi) }
    Invoke-Checked $python $packageArgs 'Package verification'
    $version = (Get-Content -LiteralPath (Join-Path $extension 'package.json') -Raw | ConvertFrom-Json).version
    $PrebuiltPackage = Join-Path $OutputDirectory "browser-bridge-$version-windows-$architecture.zip"
}

$verifyArgs = @($engine, 'verify', '--package', $PrebuiltPackage)
if ($Descriptor) { $verifyArgs += @('--descriptor', $Descriptor) }
if ($PackageSha256) { $verifyArgs += @('--sha256', $PackageSha256) }
if ($ExpectedVersion) { $verifyArgs += @('--version', $ExpectedVersion) }
Invoke-Checked $python $verifyArgs 'Offline package validation'
if ($ValidateOnly -or -not $PSCmdlet.ShouldProcess($InstallRoot, 'Install verified host/extensions and selected MCP/native targets')) { return }

$installArgs = @($engine, 'install', '--package', $PrebuiltPackage, '--install-root', $InstallRoot)
if ($Descriptor) { $installArgs += @('--descriptor', $Descriptor) }
if ($PackageSha256) { $installArgs += @('--sha256', $PackageSha256) }
if ($ExpectedVersion) { $installArgs += @('--version', $ExpectedVersion) }
foreach ($browser in $Browsers) { $installArgs += @('--browser', $browser) }
foreach ($agent in $Agents) { $installArgs += @('--agent', $agent) }
if ($CopilotConfig) { $installArgs += @('--copilot-config', $CopilotConfig) }
if ($CodexConfig) { $installArgs += @('--codex-config', $CodexConfig) }
if ($ClaudeConfig) { $installArgs += @('--claude-config', $ClaudeConfig) }
if ($ReadOnlyMcp) { $installArgs += '--read-only' }
if ($ReadWriteMcp) { $installArgs += '--read-write' }
if ($AllowEvaluate) { $installArgs += '--allow-evaluate' }
if ($DenyEvaluate) { $installArgs += '--deny-evaluate' }
if ($FirefoxDevLauncher) { $installArgs += '--firefox-dev-launcher' }
if ($FirefoxExe) { $installArgs += @('--firefox-exe', $FirefoxExe) }
Invoke-Checked $python $installArgs 'Transactional Browser Bridge installation'

if ($InstallPythonSdk) {
    Invoke-Checked $python @('-m', 'pip', 'install', (Join-Path $repo 'python')) 'Python SDK installation'
}
Write-Host 'No browser or agent was restarted. See docs\INSTALLATION.md for extension reload or Firefox activation.'