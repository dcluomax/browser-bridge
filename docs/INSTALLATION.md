# Install and update Browser Bridge

This guide applies to **Browser Bridge**:
`https://github.com/dcluomax/browser-bridge`.

## Choose an installation route

| Route | Required tools | Browser activation |
| --- | --- | --- |
| Verified prebuilt package | Python 3.11+; PowerShell on Windows or Bash on Linux/macOS | Unpacked Chromium (`edge://extensions` / `chrome://extensions`), signed Firefox XPI, or dedicated Firefox dev launcher |
| Source checkout | Python 3.11+, Node 22.15+, existing npm dependencies, Rust, platform C++ build tools | The same activation options |

Prebuilt packages do not require Rust, Node, npm, or Visual Studio.
They use the zero-dependency Python standard-library installer in `scripts/distribution.py`.
An archive checksum is an integrity check, not a signing certificate.

The installer does not start browsers, stop applications, clear profiles, copy cookies,
disable signing, enable scheduled jobs, or change an agent that you did not select.

## Windows: build the host and extensions from source

Run from the repository root:

```powershell
.\scripts\install.ps1 -Browsers edge,chrome,firefox
```

This builds `browser-bridge` and both unpacked/packaged browser extensions (`chromium` and `firefox`).
The script sets up Visual Studio C++ Build Tools and runs Cargo in the same `cmd.exe` process.
It also finds the installed stable Rust toolchain if Cargo is absent from `PATH`.

Restore npm dependencies with `npm ci` in `extension` after a missing-dependency build error.
The installer does not install toolchains or dependencies without a failure.
`-SkipExtensionBuild` uses an existing matching extension build.
A skipped build with the wrong version is not accepted.

## Windows: verified offline package

Obtain the target ZIP (`browser-bridge-0.13.1-windows-x86_64.zip` or `windows-aarch64.zip`),
matching JSON descriptor, and `.SHA256SUMS` file from the official GitHub Release or a trusted local builder.
Check the checksum before you run its installer.
Extract only its `scripts` directory to a new local folder and keep the package ZIP intact.

```powershell
.\scripts\install.ps1 `
  -PrebuiltPackage .\browser-bridge-0.13.1-windows-x86_64.zip `
  -ExpectedVersion 0.13.1 -Browsers edge,chrome,firefox
```

The installer uses the adjacent matching JSON descriptor automatically, or pass `-Descriptor <path>`.
If you have no descriptor, supply `-PackageSha256 <trusted-64-character-sha256>`.

Use `-ValidateOnly` to verify the archive without changing registrations or configurations:

```powershell
.\scripts\install.ps1 -ValidateOnly `
  -PrebuiltPackage .\browser-bridge-0.13.1-windows-x86_64.zip
```

The default install directory is `%LOCALAPPDATA%\BrowserBridge`.
Use `-InstallRoot <dedicated-directory>` if necessary.
Network paths, traversal, links, reparse points, and Windows alternate data streams are refused.

## Select agent integrations

Agent registration is opt-in:

```powershell
.\scripts\install.ps1 -Browsers edge,chrome,firefox `
  -Agents copilot,codex,claude -ReadOnlyMcp
```

| Target | Default user configuration |
| --- | --- |
| Copilot | `~\.copilot\mcp-config.json` |
| Codex | `~\.codex\config.toml` |
| Claude Code | `~\.claude.json` |

`-RegisterCopilotMcp`, `-RegisterCodexMcp`, `-RegisterClaudeMcp`, and `-RegisterAllMcp` are aliases
for selecting those targets.
Use `-CopilotConfig`, `-CodexConfig`, or `-ClaudeConfig` only with its selected target.

New entries default to read-only mode.
Evaluation is not enabled by default.
Existing `--read-only`, `--allow-evaluate`, tool allowlists, environment variables,
unknown server fields, and unrelated agents remain unchanged.
An explicit `-ReadWriteMcp` removes the read-only flag.
An explicit `-DenyEvaluate` removes the evaluation flag.
Use `-ReadWriteMcp -AllowEvaluate` only after you approve evaluation access.
Browser-side evaluation consent is still required.
The installer never adds an authentication token to an MCP configuration.

The installer changes only the managed command and applicable arguments.
It refuses a conflicting remote server or an entry owned by another executable.
Codex comments and unrelated TOML text remain intact.
Inline or dotted Browser Bridge TOML entries must first become a
`[mcp_servers.browser-bridge]` table.

An upgrade keeps the targets that you selected during earlier installations.
It does not discover or register other agents.

## Firefox: permanent signed installation

Release Firefox cannot permanently install an unsigned XPI.
Do not turn off signature verification or change existing user profiles to work around this requirement.

1. Build the matching Firefox extension.
2. Supply Mozilla API credentials through the environment from your credential store.
3. Run the guarded signing helper:

   ```powershell
   Set-Location .\extension
   node scripts\sign-firefox.mjs
   ```

The command requires `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, or
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, and uses Mozilla's unlisted signing workflow.
It never puts credentials in arguments, package files, or configurations.

Supply the resulting XPI to the package builder with `--firefox-xpi <path>`, or
to the source installer with `-FirefoxXpi <path>`.
The builder checks its ID, version, content, ZIP format, and signature-file presence
(`signature-present-unverified`); Firefox validates the cryptographic signature during installation.

In Firefox, open `about:addons` → gear menu → **Install Add-on From File**, and select the signed XPI
under the installed `extension\artifacts` directory.

## Firefox: durable development launcher

If Mozilla signing credentials are unavailable, use a dedicated development profile.
This is a supported temporary-add-on workflow, **not** a permanent signed installation.

Create the launcher without opening Firefox:

```powershell
.\scripts\install.ps1 -Browsers firefox -Agents copilot `
  -FirefoxDevLauncher -FirefoxExe 'C:\Program Files\Mozilla Firefox\firefox.exe'
```

Then start the launcher yourself:

```powershell
& "$env:LOCALAPPDATA\BrowserBridge\Launch-Browser-Bridge-Firefox.cmd"
```

The launcher:

- Creates only `BrowserBridge\firefox-development\profile` on the first launch.
- Refuses an existing unmarked profile at that path and never copies an existing profile, login, or cookie.
- Preserves this dedicated profile across launches, binds the Firefox debugger to loopback (`devtools.debugger.force-local`), and installs the temporary add-on via `addonsActor.installTemporaryAddon`.
- Checks the package, installed XPI, native hash, native version, and returned add-on ID.
- Leaves the dedicated Firefox window open until you close it, stopping only its own newly created process if activation fails.

Manual temporary activation also remains available:
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
the installed `extension\firefox\manifest.json`.

## Linux and macOS

From the checkout:

```bash
bash scripts/install.sh --browser edge --browser chrome --browser firefox --agent copilot
```

From a verified prebuilt package:

```bash
bash scripts/install.sh \
  --prebuilt-package browser-bridge-0.13.1-linux-x86_64.zip \
  --version 0.13.1 --browser firefox
```

Use the matching `macos-*` or `*-aarch64` package for your platform.
The default install directory is `~/.browser-bridge`.
Native manifests use each browser's supported current-user location (`XDG_CONFIG_HOME` honored on Linux; zero `sudo` required).

## Create verified release artifacts

After building a matching host and extension:

```powershell
python .\scripts\distribution.py pack `
  --native-binary .\rust\target\release\BrowserBridge.exe --output .\dist
```

Optional inputs are `--firefox-xpi` and `--target`.
Each output set contains a deterministic `.zip`, detached `.json` descriptor, and `.SHA256SUMS`.

## Explicit updates, pinning, and rollback

These manual commands do not run on a timer unless you explicitly enable Windows scheduling below:

```powershell
$manager = "$env:LOCALAPPDATA\BrowserBridge\tools\distribution.py"
python $manager check
python $manager apply --require-idle
python $manager pin --version 0.13.1
python $manager unpin
python $manager rollback
python $manager repair
```

On Linux/macOS, use `python3 ~/.browser-bridge/tools/distribution.py`.

`check` queries only `https://api.github.com/repos/dcluomax/browser-bridge/releases`.
Use `--version 0.13.1` to request an exact tag.
Optionally set `GITHUB_TOKEN` in your environment if you hit unauthenticated GitHub API rate limits;
the installer never saves or forwards the token to asset CDNs.

`apply` verifies the release identity, tag, descriptor, archive size, package SHA256,
manifest SHA256, every member checksum, and the native `--version` smoke test.
`--require-idle` refuses to apply if browser connections or active agent sessions exist,
rechecking idle status under the installation lock right before swapping files.

`rollback` validates the previous retained package before restoring that version.
`repair` validates and reapplies the version in the last committed `managed.json` after an interrupted transaction.

## Opt-in automatic updates on Windows

The installer supplies `tools\auto-update.ps1` without enabling any scheduled task.
After a verified installation, choose one mode if desired:

```powershell
# Checks only (default mode).
.\scripts\auto-update.ps1 -Action Enable -Mode Check

# Optional idle-safe automatic apply instead.
.\scripts\auto-update.ps1 -Action Enable -Mode Apply

# Run once now, inspect status, or disable future runs.
.\scripts\auto-update.ps1 -Action Run -Mode Check
.\scripts\auto-update.ps1 -Action Status
.\scripts\auto-update.ps1 -Action Disable
```

The task belongs strictly to the current Windows user and install directory, runs with `InteractiveToken` and `LeastPrivilege`, stores no credentials, and writes a minimal status receipt to `updates\last-run.json`.
