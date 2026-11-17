<#
.SYNOPSIS
  Zero-build 1-command installer for Browser Bridge on Windows (x64 & ARM64).
  Downloads SHA-256-verified prebuilt binaries and unpacked extensions from GitHub Releases,
  registers Native Messaging hosts, and auto-configures installed AI MCP clients.

.EXAMPLE
  irm https://raw.githubusercontent.com/dcluomax/browser-bridge/main/scripts/bootstrap.ps1 | iex

.EXAMPLE
  .\scripts\bootstrap.ps1 -ReadOnlyMcp -InstallPythonSdk
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$Repo = 'dcluomax/browser-bridge',
    [string]$InstallRoot = '',
    [switch]$ReadOnlyMcp,
    [switch]$AllowEvaluate,
    [switch]$InstallPythonSdk,
    [switch]$SkipNativeInstall,
    [switch]$SkipMcpConfig
)

$ErrorActionPreference = 'Stop'

if (-not $InstallRoot) {
    $InstallRoot = if ($env:BROWSER_BRIDGE_INSTALL_ROOT) {
        $env:BROWSER_BRIDGE_INSTALL_ROOT
    } else {
        Join-Path $env:LOCALAPPDATA 'BrowserBridge'
    }
}

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$platformLabel = switch ($arch) {
    'Arm64' { 'windows-arm64' }
    'X64'   { 'windows-x64' }
    default { throw "Unsupported Windows architecture '$arch'. Clone https://github.com/$Repo and run .\scripts\install.ps1 to build from source." }
}

$apiUrl = if ($Version -eq 'latest') {
    "https://api.github.com/repos/$Repo/releases/latest"
} else {
    $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
    "https://api.github.com/repos/$Repo/releases/tags/$tag"
}

Write-Host "==> Resolving Browser Bridge release ($Version) for $platformLabel..." -ForegroundColor Cyan
$headers = @{ 'User-Agent' = 'BrowserBridge-Bootstrap/1.0'; 'Accept' = 'application/vnd.github+json' }
$release = Invoke-RestMethod -Uri $apiUrl -Headers $headers
$tagName = [string]$release.tag_name
$verNum = $tagName.TrimStart('v')

function Get-ReleaseAsset {
    param([Parameter(Mandatory)][string]$Name)
    $asset = $release.assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $asset) {
        throw "Release $tagName does not contain expected asset '$Name'."
    }
    return $asset
}

function Save-VerifiedAsset {
    param(
        [Parameter(Mandatory)]$Asset,
        [Parameter(Mandatory)][string]$Destination
    )
    Write-Host "  Downloading $($Asset.name)..."
    Invoke-WebRequest -Uri $Asset.browser_download_url -Headers $headers -OutFile $Destination -UseBasicParsing
    if ($Asset.digest -and ([string]$Asset.digest).StartsWith('sha256:')) {
        $expected = ([string]$Asset.digest).Substring(7).ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "SHA-256 verification failed for $($Asset.name): expected $expected, got $actual."
        }
        Write-Host "  Verified SHA-256 ($($expected.Substring(0, 12))...)" -ForegroundColor DarkGreen
    }
}

function Expand-BundleArchive {
    param(
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)][string]$DestinationDir
    )
    if (Test-Path $DestinationDir) {
        Remove-Item -LiteralPath $DestinationDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null
    $bytes = [System.IO.File]::ReadAllBytes($ArchivePath)
    $isZip = ($bytes.Length -ge 4 -and $bytes[0] -eq 0x50 -and $bytes[1] -eq 0x4B)
    if ($isZip) {
        $zipCopy = if ($ArchivePath.EndsWith('.zip')) { $ArchivePath } else { "$ArchivePath.zip" }
        if ($zipCopy -ne $ArchivePath) { Copy-Item -LiteralPath $ArchivePath -Destination $zipCopy -Force }
        Expand-Archive -LiteralPath $zipCopy -DestinationPath $DestinationDir -Force
    } else {
        & tar.exe -xf $ArchivePath -C $DestinationDir
        if ($LASTEXITCODE -ne 0) { throw "Failed to extract $ArchivePath" }
    }
}

function Get-ChromiumIdFromPublicKey {
    param([Parameter(Mandatory)][string]$PublicKeyBase64)
    $der = [Convert]::FromBase64String($PublicKeyBase64)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($der)
    } finally {
        $sha.Dispose()
    }
    $hex = -join ($hash[0..15] | ForEach-Object { $_.ToString('x2') })
    $chars = foreach ($ch in $hex.ToCharArray()) {
        [char]([int][char]'a' + [Convert]::ToInt32([string]$ch, 16))
    }
    return (-join $chars)
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "bb-bootstrap-$PID"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
    $hostAsset = Get-ReleaseAsset "browser-bridge-$platformLabel.zip"
    $chromiumAsset = Get-ReleaseAsset "browser-bridge-chromium-$verNum.zip"
    $firefoxAsset = Get-ReleaseAsset "browser-bridge-firefox-$verNum.xpi"

    $hostZip = Join-Path $tmpDir $hostAsset.name
    $chromiumZip = Join-Path $tmpDir $chromiumAsset.name
    $firefoxXpi = Join-Path $tmpDir $firefoxAsset.name

    Save-VerifiedAsset -Asset $hostAsset -Destination $hostZip
    Save-VerifiedAsset -Asset $chromiumAsset -Destination $chromiumZip
    Save-VerifiedAsset -Asset $firefoxAsset -Destination $firefoxXpi

    $stageHost = Join-Path $tmpDir 'host'
    Expand-BundleArchive -ArchivePath $hostZip -DestinationDir $stageHost

    $appDir = Join-Path $InstallRoot 'app'
    $extHome = Join-Path $InstallRoot 'extension'
    New-Item -ItemType Directory -Path $appDir -Force | Out-Null
    New-Item -ItemType Directory -Path $extHome -Force | Out-Null

    $targetExe = Join-Path $appDir 'BrowserBridge.exe'
    $running = Get-CimInstance Win32_Process -Filter "Name = 'BrowserBridge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $targetExe }
    foreach ($proc in $running) {
        $live = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
        if ($live) {
            Stop-Process -Id $proc.ProcessId -Force
            $null = $live.WaitForExit(5000)
        }
    }

    Copy-Item -LiteralPath (Join-Path $stageHost 'BrowserBridge.exe') -Destination $targetExe -Force
    if (Test-Path (Join-Path $stageHost 'AGENT.md')) {
        Copy-Item -LiteralPath (Join-Path $stageHost 'AGENT.md') -Destination (Join-Path $InstallRoot 'AGENT.md') -Force
    }

    Expand-BundleArchive -ArchivePath $chromiumZip -DestinationDir (Join-Path $extHome 'chromium')
    Expand-BundleArchive -ArchivePath $firefoxXpi -DestinationDir (Join-Path $extHome 'firefox')

    $chromiumManifest = Get-Content (Join-Path $extHome 'chromium\manifest.json') -Raw | ConvertFrom-Json
    $firefoxManifest = Get-Content (Join-Path $extHome 'firefox\manifest.json') -Raw | ConvertFrom-Json
    $chromiumId = Get-ChromiumIdFromPublicKey -PublicKeyBase64 ([string]$chromiumManifest.key)
    $geckoId = [string]$firefoxManifest.browser_specific_settings.gecko.id

    if (-not $SkipNativeInstall) {
        & $targetExe install --chromium-id $chromiumId --gecko-id $geckoId --host-path $targetExe | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Native messaging host registration failed.' }
    }

    if (-not $SkipMcpConfig) {
        $mcpArgs = @('mcp')
        if ($ReadOnlyMcp) { $mcpArgs += '--read-only' }
        if ($AllowEvaluate) { $mcpArgs += '--allow-evaluate' }

        function Set-McpServerEntry {
            param(
                [string]$ConfigPath,
                [string]$RootKey,
                [pscustomobject]$Entry,
                [string]$Label
            )
            $parent = Split-Path -Parent $ConfigPath
            if ($parent -and -not (Test-Path $parent)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            $doc = if (Test-Path $ConfigPath) { Get-Content $ConfigPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
            if (-not $doc.PSObject.Properties[$RootKey]) {
                $doc | Add-Member -NotePropertyName $RootKey -NotePropertyValue ([pscustomobject]@{})
            }
            $doc.$RootKey | Add-Member -NotePropertyName 'browser-bridge' -NotePropertyValue $Entry -Force
            ($doc | ConvertTo-Json -Depth 10) | Set-Content $ConfigPath -Encoding utf8
            Write-Host "  Registered MCP server for $Label -> $ConfigPath" -ForegroundColor Green
        }

        $userHome = if ($env:BROWSER_BRIDGE_HOME_OVERRIDE) { $env:BROWSER_BRIDGE_HOME_OVERRIDE } else { $HOME }

        # Always register GitHub Copilot CLI config (~/.copilot/mcp-config.json)
        Set-McpServerEntry `
            -ConfigPath (Join-Path $userHome '.copilot\mcp-config.json') `
            -RootKey 'mcpServers' `
            -Entry ([pscustomobject]@{ type = 'local'; command = $targetExe; args = $mcpArgs; tools = @('*') }) `
            -Label 'GitHub Copilot CLI'

        # Auto-register VS Code / VS Code Insiders if installed
        foreach ($vsVariant in @('Code', 'Code - Insiders')) {
            $vsUserDir = Join-Path $env:APPDATA "$vsVariant\User"
            if (Test-Path $vsUserDir) {
                Set-McpServerEntry `
                    -ConfigPath (Join-Path $vsUserDir 'mcp.json') `
                    -RootKey 'servers' `
                    -Entry ([pscustomobject]@{ type = 'stdio'; command = $targetExe; args = $mcpArgs }) `
                    -Label "VS Code ($vsVariant)"
            }
        }

        # Auto-register Claude Desktop if installed
        $claudeDir = Join-Path $env:APPDATA 'Claude'
        if (Test-Path $claudeDir) {
            Set-McpServerEntry `
                -ConfigPath (Join-Path $claudeDir 'claude_desktop_config.json') `
                -RootKey 'mcpServers' `
                -Entry ([pscustomobject]@{ command = $targetExe; args = $mcpArgs }) `
                -Label 'Claude Desktop'
        }

        # Auto-register Claude Code (~/.claude.json) if present
        $claudeCodeJson = Join-Path $userHome '.claude.json'
        if (Test-Path $claudeCodeJson) {
            Set-McpServerEntry `
                -ConfigPath $claudeCodeJson `
                -RootKey 'mcpServers' `
                -Entry ([pscustomobject]@{ type = 'stdio'; command = $targetExe; args = $mcpArgs }) `
                -Label 'Claude Code'
        }

        # Auto-register Cursor if installed
        $cursorDir = Join-Path $userHome '.cursor'
        if (Test-Path $cursorDir) {
            Set-McpServerEntry `
                -ConfigPath (Join-Path $cursorDir 'mcp.json') `
                -RootKey 'mcpServers' `
                -Entry ([pscustomobject]@{ command = $targetExe; args = $mcpArgs }) `
                -Label 'Cursor'
        }

        # Auto-register Windsurf if installed
        $windsurfDir = Join-Path $userHome '.codeium\windsurf'
        if (Test-Path $windsurfDir) {
            Set-McpServerEntry `
                -ConfigPath (Join-Path $windsurfDir 'mcp_config.json') `
                -RootKey 'mcpServers' `
                -Entry ([pscustomobject]@{ command = $targetExe; args = $mcpArgs }) `
                -Label 'Windsurf'
        }
    }

    if ($InstallPythonSdk) {
        $whlAsset = $release.assets | Where-Object { $_.name -like 'browser_bridge-*.whl' } | Select-Object -First 1
        if ($whlAsset) {
            $whlPath = Join-Path $tmpDir $whlAsset.name
            Save-VerifiedAsset -Asset $whlAsset -Destination $whlPath
            python -m pip install --force-reinstall $whlPath | Out-Host
        }
    }

    Write-Host ''
    Write-Host "Browser Bridge $tagName is installed and ready!" -ForegroundColor Green
    Write-Host "  Host & MCP server:   $targetExe"
    Write-Host "  Chromium extension:  $extHome\chromium   (ID: $chromiumId)"
    Write-Host "  Firefox extension:   $extHome\firefox\manifest.json   (ID: $geckoId)"
    Write-Host ''
    Write-Host 'Final one-time step in your browser:' -ForegroundColor Yellow
    Write-Host "  Edge:    edge://extensions   -> Enable 'Developer mode' -> 'Load unpacked' -> $extHome\chromium"
    Write-Host "  Chrome:  chrome://extensions -> Enable 'Developer mode' -> 'Load unpacked' -> $extHome\chromium"
    Write-Host "  Firefox: about:debugging#/runtime/this-firefox -> 'Load Temporary Add-on' -> $extHome\firefox\manifest.json"
} finally {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
