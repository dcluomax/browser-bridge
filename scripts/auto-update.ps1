<#
.SYNOPSIS
  Opt-in current-user Browser Bridge update checks or idle-safe automatic apply on Windows.
.DESCRIPTION
  Enable registers one owned, least-privilege, interactive-user Task Scheduler task.
  Check is the default mode. Apply always uses distribution.py apply --require-idle.
  No credentials, execution-policy overrides, browser launches, or task registrations
  occur merely by installing or dot-sourcing this file.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Enable', 'Disable', 'Status', 'Run', 'Plan')][string]$Action = 'Status',
    [ValidateSet('Check', 'Apply')][string]$Mode = 'Check',
    [string]$InstallRoot,
    [string]$PythonExe,
    [ValidateRange(15, 1440)][int]$IntervalMinutes = 360
)

$ErrorActionPreference = 'Stop'
$script:BrowserBridgeUpdaterSource = $PSCommandPath

function Resolve-BrowserBridgeUpdatePath {
    param([Parameter(Mandatory)][string]$Path, [switch]$AllowAppExecutionAlias)
    if ($Path -match '[\x00-\x1f"*?<>|]' -or $Path -match '^(\\\\|//)' -or
        @($Path -split '[/\\]' | Where-Object { $_ -eq '..' }).Count -gt 0) {
        throw 'An updater path contains traversal, a network path, or unsupported characters.'
    }
    $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($resolved -notmatch '^[A-Za-z]:\\' -or $resolved.Substring(2).Contains(':')) {
        throw 'Use an absolute local Windows path without alternate data streams.'
    }
    $appsPrefix = if ($env:LOCALAPPDATA) {
        [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps')).TrimEnd('\') + '\'
    } else { '' }
    $cursor = $resolved
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                $isStoreAlias = $AllowAppExecutionAlias -and ($cursor -eq $resolved) -and ($null -eq $item.LinkType) -and
                    $appsPrefix -and $resolved.StartsWith($appsPrefix, [System.StringComparison]::OrdinalIgnoreCase)
                if (-not $isStoreAlias) {
                    throw "Updater paths cannot use links or reparse points: $cursor"
                }
            }
        }
        $parent = [System.IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $resolved
}

function Get-BrowserBridgeUpdateArguments {
    param([string[]]$Values)
    return (($Values | ForEach-Object {
        if ($_ -match '[\x00-\x1f"]') { throw 'An updater argument contains unsupported characters.' }
        '"' + ([regex]::Replace($_, '(\\+)$', '$1$1')) + '"'
    }) -join ' ')
}

function Get-BrowserBridgeUpdatePlan {
    param([string]$Root, [string]$Python, [string]$UpdateMode = 'Check', [int]$Interval = 360)
    if ($UpdateMode -notin @('Check', 'Apply') -or $Interval -lt 15 -or $Interval -gt 1440) {
        throw 'Select Check or Apply with an interval from 15 to 1440 minutes.'
    }
    if (-not $Root) { $Root = Join-Path $env:LOCALAPPDATA 'BrowserBridge' }
    $Root = Resolve-BrowserBridgeUpdatePath $Root
    if ($Root -eq [System.IO.Path]::GetPathRoot($Root).TrimEnd('\') -or $Root -eq $HOME) {
        throw 'Use a dedicated Browser Bridge install directory.'
    }
    $metadataPath = Resolve-BrowserBridgeUpdatePath (Join-Path $Root 'managed.json')
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf) -or (Get-Item -LiteralPath $metadataPath).Length -gt 1MB) {
        throw 'Install a verified Browser Bridge package before scheduling updates.'
    }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.project -ne 'browser-bridge' -or $metadata.repository -ne 'https://github.com/dcluomax/browser-bridge' -or
        $metadata.schemaVersion -ne 1 -or $metadata.nativeHostName -ne 'io.github.dcluomax.browser_bridge' -or
        $metadata.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or
        $metadata.nativeVersion -ne $metadata.version -or $metadata.extensionVersion -ne $metadata.version) {
        throw 'Managed installation identity or version is invalid. No task was changed.'
    }
    if (-not $Python) {
        $command = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $Python = $command.Source
    }
    $Python = Resolve-BrowserBridgeUpdatePath $Python -AllowAppExecutionAlias
    $engine = Resolve-BrowserBridgeUpdatePath (Join-Path $Root 'tools\distribution.py')
    if (-not (Test-Path -LiteralPath $Python -PathType Leaf) -or -not (Test-Path -LiteralPath $engine -PathType Leaf)) {
        throw 'The installed update engine and Python executable must exist.'
    }
    $worker = Resolve-BrowserBridgeUpdatePath (Join-Path $Root 'tools\auto-update.ps1')
    $shell = Resolve-BrowserBridgeUpdatePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant())) } finally { $hasher.Dispose() }
    $suffix = ([BitConverter]::ToString($digest)).Replace('-', '').Substring(0, 12).ToLowerInvariant()
    $name = "BrowserBridge-Updates-$sid-$suffix"
    $description = "Browser Bridge updater v1; repository=https://github.com/dcluomax/browser-bridge; owner=$sid; root=$Root"
    $arguments = "-NoProfile -NonInteractive -File `"$worker`" -Action Run -Mode $UpdateMode -InstallRoot `"$Root`" -PythonExe `"$Python`""
    $escape = { param($Value) [System.Security.SecurityElement]::Escape([string]$Value) }
    $idle = if ($UpdateMode -eq 'Apply') { 'true' } else { 'false' }
    $start = [DateTime]::Now.AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ss')
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$(& $escape $description)</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><Repetition><Interval>PT${Interval}M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$start</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="CurrentUser"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><Duration>PT1M</Duration><WaitTimeout>PT1H</WaitTimeout><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>$idle</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="CurrentUser"><Exec><Command>$(& $escape $shell)</Command><Arguments>$(& $escape $arguments)</Arguments></Exec></Actions>
</Task>
"@
    return [pscustomobject]@{
        taskName = $name; taskPath = '\'; ownerSid = $sid; installRoot = $Root
        mode = $UpdateMode; intervalMinutes = $Interval; python = $Python
        engine = $engine; worker = $worker; shell = $shell; arguments = $arguments
        description = $description; xml = $xml
    }
}

function Get-BrowserBridgeTaskFolder {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    return $service.GetFolder('\')
}

function Find-BrowserBridgeUpdateTask {
    param($Folder, $Plan)
    try { return $Folder.GetTask($Plan.taskName) }
    catch [System.Management.Automation.MethodInvocationException] {
        if ($_.Exception.InnerException -is [System.Runtime.InteropServices.COMException] -and
            $_.Exception.InnerException.HResult -eq -2147024894) { return $null }
        throw
    }
    catch [System.Runtime.InteropServices.COMException] {
        if ($_.Exception.HResult -eq -2147024894) { return $null }
        throw
    }
}

function Assert-BrowserBridgeOwnedUpdateTask {
    param($Task, $Plan)
    if (-not $Task) { return }
    [xml]$definition = $Task.Xml
    $expected = '^-NoProfile -NonInteractive -File "' + [regex]::Escape($Plan.worker) +
        '" -Action Run -Mode (Check|Apply) -InstallRoot "' + [regex]::Escape($Plan.installRoot) + '" -PythonExe "[^"]+"$'
    if ($definition.Task.RegistrationInfo.Description -ne $Plan.description -or
        $definition.Task.Principals.Principal.UserId -ne $Plan.ownerSid -or
        $definition.Task.Principals.Principal.LogonType -ne 'InteractiveToken' -or
        $definition.Task.Principals.Principal.RunLevel -ne 'LeastPrivilege' -or
        @($definition.Task.Actions.Exec).Count -ne 1 -or $definition.Task.Actions.Exec.Command -ne $Plan.shell -or
        $definition.Task.Actions.Exec.Arguments -notmatch $expected) {
        throw 'Refusing to change a task that is not the current user-owned Browser Bridge updater.'
    }
}

function Invoke-BrowserBridgeUpdatePython {
    param($Plan, [string[]]$Arguments)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Plan.python
    $start.Arguments = Get-BrowserBridgeUpdateArguments $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(600000)) {
            $process.Kill()
            $process.WaitForExit()
            return [pscustomobject]@{ exitCode = 124; output = ''; error = 'The owned update helper timed out. Use repair if it was interrupted.' }
        }
        return [pscustomobject]@{ exitCode = $process.ExitCode; output = $output.GetAwaiter().GetResult(); error = $errors.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}

function Assert-BrowserBridgeAutomaticUpdateEngine {
    param($Plan)
    $probe = "import runpy,sys; sys.path.insert(0,sys.argv[1]); data=runpy.run_path(sys.argv[2]); sys.exit(0 if sys.version_info >= (3,11) and data.get('SAFE_AUTOMATIC_UPDATE_VERSION') == 1 else 1)"
    $result = Invoke-BrowserBridgeUpdatePython $Plan @('-c', $probe, (Split-Path -Parent $Plan.engine), $Plan.engine)
    if ($result.exitCode -ne 0) { throw 'Reinstall a verified package with idle-safe automatic update support before enabling Apply mode.' }
}

function Write-BrowserBridgeUpdateReceipt {
    param($Plan, $Receipt)
    $destination = Resolve-BrowserBridgeUpdatePath (Join-Path $Plan.installRoot 'updates\last-run.json')
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $pending = Join-Path $parent ('.last-run-' + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        [System.IO.File]::WriteAllText($pending, ($Receipt | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $destination) { [System.IO.File]::Replace($pending, $destination, $null) }
        else { [System.IO.File]::Move($pending, $destination) }
    } finally { if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force } }
}

function Invoke-BrowserBridgeUpdateRun {
    param($Plan)
    if ($Plan.mode -eq 'Apply') { Assert-BrowserBridgeAutomaticUpdateEngine $Plan }
    $operation = if ($Plan.mode -eq 'Apply') { 'apply' } else { 'check' }
    $arguments = @($Plan.engine, $operation, '--install-root', $Plan.installRoot)
    if ($Plan.mode -eq 'Apply') { $arguments += '--require-idle' }
    $result = Invoke-BrowserBridgeUpdatePython $Plan $arguments
    $receipt = [ordered]@{
        schemaVersion = 1; repository = 'https://github.com/dcluomax/browser-bridge'
        checkedAt = [DateTimeOffset]::UtcNow.ToString('o'); mode = $Plan.mode
        exitCode = $result.exitCode; status = 'failed'
    }
    if ($result.exitCode -eq 0) {
        $data = $result.output | ConvertFrom-Json
        $receipt.status = 'completed'
        foreach ($key in @('installedVersion', 'availableVersion', 'pinnedVersion', 'updateAvailable')) {
            if ($data.PSObject.Properties[$key]) { $receipt[$key] = $data.$key }
        }
        if ($data.PSObject.Properties['version']) { $receipt.installedVersion = $data.version }
    } elseif ($result.exitCode -eq 3 -and $Plan.mode -eq 'Apply') {
        $receipt.status = 'skipped-active-or-unverified'
    }
    Write-BrowserBridgeUpdateReceipt $Plan $receipt
    if ($receipt.status -eq 'failed') { throw "Update check/apply failed (exit $($result.exitCode)): $($result.error.Trim())" }
    if ($result.error) { Write-Host $result.error.Trim() }
    return [pscustomobject]$receipt
}

function Invoke-BrowserBridgeAutoUpdate {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$UpdateAction, $Plan)
    if ($UpdateAction -eq 'Plan') { return $Plan }
    if ($UpdateAction -eq 'Run') { return Invoke-BrowserBridgeUpdateRun $Plan }
    if ($UpdateAction -notin @('Enable', 'Disable', 'Status')) { throw 'Unknown updater action.' }
    if ($UpdateAction -ne 'Status' -and -not $PSCmdlet.ShouldProcess($Plan.taskName, $UpdateAction)) { return $Plan }
    $folder = Get-BrowserBridgeTaskFolder
    $task = Find-BrowserBridgeUpdateTask $folder $Plan
    Assert-BrowserBridgeOwnedUpdateTask $task $Plan
    if ($UpdateAction -eq 'Enable') {
        if ($task -and $task.State -eq 4) { throw 'The owned updater is running. Wait for it to finish; no process was stopped.' }
        if ($Plan.mode -eq 'Apply') { Assert-BrowserBridgeAutomaticUpdateEngine $Plan }
        if (Test-Path -LiteralPath $Plan.worker) {
            if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($Plan.worker)) -ne
                [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:BrowserBridgeUpdaterSource))) {
                throw 'The installed updater differs from this controller. Reinstall the verified package; do not overwrite a customized script.'
            }
        } else {
            $pending = $Plan.worker + '.new-' + [Guid]::NewGuid().ToString('N')
            try { [IO.File]::Copy($script:BrowserBridgeUpdaterSource, $pending, $false); [IO.File]::Move($pending, $Plan.worker) }
            finally { if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force } }
        }
        $flags = if ($task) { 4 } else { 2 }
        $null = $folder.RegisterTask($Plan.taskName, $Plan.xml, $flags, $Plan.ownerSid, $null, 3, $null)
        return [pscustomobject]@{ enabled = $true; taskName = $Plan.taskName; mode = $Plan.mode; intervalMinutes = $Plan.intervalMinutes }
    }
    if ($UpdateAction -eq 'Disable') {
        if ($task -and $task.State -eq 4) {
            $task.Enabled = $false
            return [pscustomobject]@{ enabled = $false; running = $true; message = 'Future runs disabled. The current owned run was not stopped; disable again after it finishes to remove the task.' }
        }
        if ($task) { $folder.DeleteTask($Plan.taskName, 0) }
        return [pscustomobject]@{ enabled = $false; taskName = $Plan.taskName }
    }
    $receipt = Resolve-BrowserBridgeUpdatePath (Join-Path $Plan.installRoot 'updates\last-run.json')
    return [pscustomobject]@{
        enabled = [bool]($task -and $task.Enabled); taskName = $Plan.taskName
        mode = $(if ($task) { [regex]::Match(([xml]$task.Xml).Task.Actions.Exec.Arguments, '-Mode (Check|Apply)').Groups[1].Value } else { $null })
        running = [bool]($task -and $task.State -eq 4)
        lastTaskResult = $(if ($task) { $task.LastTaskResult } else { $null })
        lastRun = $(if (Test-Path -LiteralPath $receipt) { Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json } else { $null })
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $plan = Get-BrowserBridgeUpdatePlan $InstallRoot $PythonExe $Mode $IntervalMinutes
    Invoke-BrowserBridgeAutoUpdate $Action $plan -WhatIf:$WhatIfPreference | ConvertTo-Json -Depth 8
}
