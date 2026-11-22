"""Synthetic package/installer tests. No production binary or user browser is run."""

from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tomllib
import unittest
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path
from unittest import mock

REPO = Path(__file__).absolute().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import distribution as d
import firefox_dev as f
from agent_config import ConfigError, merge_codex_config, merge_json_config


def synthetic_binary(version: str, target: str) -> bytes:
    header = bytearray(160)
    architecture = target.rsplit("-", 1)[-1]
    if target.startswith("windows-"):
        header[:2] = b"MZ"
        header[60:64] = (64).to_bytes(4, "little")
        header[64:68] = b"PE\0\0"
        header[68:70] = (0x8664 if architecture == "x86_64" else 0xAA64).to_bytes(2, "little")
    elif target.startswith("linux-"):
        header[:6] = b"\x7fELF\x02\x01"
        header[18:20] = (62 if architecture == "x86_64" else 183).to_bytes(2, "little")
    else:
        header[:4] = b"\xcf\xfa\xed\xfe"
        header[4:8] = (0x01000007 if architecture == "x86_64" else 0x0100000C).to_bytes(4, "little")
    return bytes(header) + f"BBTEST_VERSION={version}\n".encode()


def fixture_runner(executable: Path, args: list[str]) -> str:
    if args == ["--version"]:
        match = re.search(rb"BBTEST_VERSION=([0-9.]+)", d.read_file(executable))
        if not match:
            raise d.DistributionError("Synthetic fixture has no version marker.")
        return match[1].decode()
    if args == ["status", "--json"]:
        return json.dumps({"hostVersion": fixture_runner(executable, ["--version"]), "browsers": []})
    raise AssertionError(f"Unexpected synthetic native invocation: {args}")


def fixture_register(transaction: d.FileTransaction, root: Path, executable: Path, browsers: list[str]) -> None:
    for browser in browsers:
        transaction.replace_file(root / ".fixture-native" / (browser + ".json"), d.native_manifest(executable, browser))


def raw_zip(files: dict[str, bytes], linked: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, content in files.items():
            entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777 if name == linked else stat.S_IFREG | 0o644) << 16
            archive.writestr(entry, content)
    return buffer.getvalue()


class FixtureCase(unittest.TestCase):
    def setUp(self):
        self.work = Path.cwd() / (".browser-bridge-tests-" + uuid.uuid4().hex)
        self.work.mkdir()
        self.source = self.work / "source"
        self.install_root = self.work / "installed"
        self.target = d.current_target()
        self.config = json.loads((REPO / "extension" / "bridge.config.json").read_text(encoding="utf-8"))

    def tearDown(self):
        shutil.rmtree(self.work)

    @staticmethod
    def write(path: Path, content: bytes | str):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode() if isinstance(content, str) else content)

    def fixture_source(self, version: str):
        self.write(self.source / "package.json", d.json_bytes({"version": version}))
        self.write(self.source / "extension" / "package.json", d.json_bytes({"version": version}))
        lock = {"version": version, "packages": {"": {"version": version}}}
        self.write(self.source / "extension" / "package-lock.json", d.json_bytes(lock))
        self.write(self.source / "extension" / "bridge.config.json", d.json_bytes(self.config))
        self.write(self.source / "extension" / "src" / "shared" / "protocol.ts", "export const PROTOCOL_VERSION = 1;")
        self.write(self.source / "rust" / "Cargo.toml", f'[workspace.package]\nversion = "{version}"\n')
        self.write(self.source / "rust" / "Cargo.lock", "".join(
            f'[[package]]\nname = "{name}"\nversion = "{version}"\n'
            for name in ("bridge-core", "browser-bridge")
        ))
        self.write(self.source / "rust" / "crates" / "bridge-core" / "src" / "lib.rs", "pub const PROTOCOL_VERSION: i64 = 1;")
        self.write(self.source / "python" / "pyproject.toml", f'[project]\nversion = "{version}"\n')
        for name in (*d.BOOTSTRAP, *d.OPTIONAL_BOOTSTRAP):
            path = REPO.joinpath(*name.split("/"))
            if path.exists():
                self.write(self.source.joinpath(*name.split("/")), path.read_bytes())
        for browser in ("chromium", "firefox"):
            manifest = {"version": version, "permissions": ["nativeMessaging"]}
            if browser == "chromium":
                manifest.update({"manifest_version": 3, "key": self.config["chromiumPublicKey"]})
            else:
                manifest.update({"manifest_version": 2, "browser_specific_settings": {"gecko": {"id": d.GECKO_ID}}})
            directory = self.source / "extension" / "dist" / browser
            self.write(directory / "manifest.json", d.json_bytes(manifest))
            self.write(directory / "background.js", f"// Synthetic extension fixture {version}\n")
            self.write(directory / "popup.html", "<!doctype html><title>Fixture</title>")
        binary = self.source / "native" / d.native_name(self.target)
        self.write(binary, synthetic_binary(version, self.target))
        return binary

    def package(self, version: str = "0.13.0") -> d.VerifiedPackage:
        native = self.fixture_source(version)
        path, descriptor = d.package_artifact(
            self.source, native, self.work / ("output-" + version),
            target=self.target, runner=fixture_runner,
        )
        return d.verify_package(
            path.read_bytes(), expected_sha256=descriptor["sha256"], expected_size=descriptor["size"],
            expected_manifest_sha256=descriptor["manifestSha256"], target=self.target, version=version,
        )

    def install(self, package: d.VerifiedPackage, **kwargs) -> dict:
        kwargs.setdefault("browsers", ["firefox"])
        kwargs.setdefault("runner", fixture_runner)
        kwargs.setdefault("register", fixture_register)
        return d.install_package(package, self.install_root, **kwargs)

    def copilot(self) -> tuple[Path, dict]:
        path = self.work / "agents" / "copilot.json"
        value = {
            "unknownRoot": {"keep": [1, 2, {"policy": "unchanged"}]},
            "mcpServers": {
                "other-tool": {"type": "http", "url": "https://example.invalid/mcp", "tools": ["safe"]},
                "browser-bridge": {
                    "type": "local", "command": r"C:\previous\BrowserBridge.exe",
                    "args": ["mcp", "--read-only", "--allow-evaluate", "--custom-flag"],
                    "tools": ["browser_tabs"], "env": {"EXTRA_SETTING": "preserve-me"},
                    "unknownField": {"enabled": False},
                },
            },
        }
        self.write(path, d.json_bytes(value))
        return path, value

    def remote(self, package: d.VerifiedPackage):
        manifest = package.manifest
        stem = f"browser-bridge-{manifest['version']}-{manifest['target']}"
        base = d.REPOSITORY + "/releases/download/v" + manifest["version"] + "/"
        descriptor = {
            **{key: manifest[key] for key in ("schemaVersion", "project", "repository", "version",
                "nativeVersion", "extensionVersion", "nativeHostName", "chromiumExtensionId", "geckoId", "protocolVersion", "target")},
            "file": stem + ".zip", "size": len(package.data),
            "sha256": package.digest, "manifestSha256": package.manifest_digest,
        }
        raw_descriptor = d.json_bytes(descriptor)
        release = {
            "tag_name": "v" + manifest["version"], "draft": False, "prerelease": False,
            "assets": [
                {"name": stem + ".json", "size": len(raw_descriptor), "browser_download_url": base + stem + ".json"},
                {"name": stem + ".zip", "size": len(package.data), "browser_download_url": base + stem + ".zip"},
            ],
        }
        contents = {
            d.API + "/releases/latest": d.json_bytes(release),
            d.API + "/releases/tags/v" + manifest["version"]: d.json_bytes(release),
            base + stem + ".json": raw_descriptor, base + stem + ".zip": package.data,
        }
        requests = []

        def fetch(url, limit, expected_size=None):
            d.trusted_url(url)
            requests.append(url)
            if url not in contents:
                raise d.DistributionError("Fixture release is unavailable.")
            data = contents[url]
            if len(data) > limit or (expected_size is not None and len(data) != expected_size):
                raise d.DistributionError("Synthetic release download failed its size check.")
            return data
        return descriptor, release, contents, requests, fetch


class PackageTests(FixtureCase):
    def test_source_versions_are_aligned_in_real_owned_metadata(self):
        self.assertEqual(d.source_version(REPO), "0.13.1")

    def test_patch_release_metadata_and_archives_align_without_reusing_old_version_bytes(self):
        self.install(self.package("0.13.0"))
        package = self.package("0.13.1")
        self.assertEqual(package.manifest["version"], "0.13.1")
        self.assertEqual(package.manifest["nativeVersion"], "0.13.1")
        self.assertEqual(package.manifest["extensionVersion"], "0.13.1")
        for browser in ("chromium", "firefox"):
            self.assertEqual(json.loads(package.files[f"extension/{browser}/manifest.json"])["version"], "0.13.1")
        self.assertEqual(self.install(package)["version"], "0.13.1")

    def test_cli_pack_accepts_dot_relative_root_binary_and_output(self):
        native = self.fixture_source("0.13.0")
        prefix = ".\\" if os.name == "nt" else "./"
        relative = lambda path: prefix + str(path.relative_to(Path.cwd()))
        output = self.work / "dot-relative-output"
        package_artifact = d.package_artifact
        def synthetic_pack(root, binary, destination, **kwargs):
            return package_artifact(root, binary, destination, runner=fixture_runner, **kwargs)
        with mock.patch.object(d, "package_artifact", side_effect=synthetic_pack):
            with contextlib.redirect_stdout(io.StringIO()):
                code = d.main(["pack", "--root", relative(self.source),
                               "--native-binary", relative(native), "--output", relative(output)])
        self.assertEqual(code, 0)
        package = output / f"browser-bridge-0.13.0-{self.target}.zip"
        self.assertEqual(d.package_from_path(package).manifest["nativeVersion"], "0.13.0")

    def test_popup_css_sidecar_is_packaged_but_unexpected_css_is_still_refused(self):
        native = self.fixture_source("0.13.0")
        for browser in ("chromium", "firefox"):
            directory = self.source / "extension" / "dist" / browser
            self.write(directory / "popup.css", ".fixture { color: blue; }\n")
            self.write(directory / "popup.html", '<!doctype html><link rel="stylesheet" href="popup.css">')
        path, _ = d.package_artifact(self.source, native, self.work / "css-output", runner=fixture_runner)
        package = d.verify_package(path.read_bytes())
        for browser, suffix in (("chromium", "zip"), ("firefox", "xpi")):
            content = package.files[f"extension/{browser}/popup.css"]
            archive = d.zip_files(package.files[f"extension/artifacts/browser-bridge-{browser}-0.13.0.{suffix}"], browser)
            self.assertEqual(archive["popup.css"], content)
        self.write(self.source / "extension" / "dist" / "firefox" / "unexpected.css", ".unknown {}")
        with self.assertRaisesRegex(d.DistributionError, "unexpected"):
            d.package_artifact(self.source, native, self.work / "refused-css", runner=fixture_runner)

    def test_real_zip_xpi_checksums_and_exact_matching_versions(self):
        package = self.package()
        self.assertEqual(package.manifest["nativeVersion"], "0.13.0")
        self.assertEqual(package.manifest["extensionVersion"], "0.13.0")
        self.assertEqual(package.manifest["protocolVersion"], 1)
        self.assertEqual(package.manifest["firefoxSigning"], "unsigned-development")
        self.assertTrue(package.data.startswith(b"PK\x03\x04"))
        xpi = package.files["extension/artifacts/browser-bridge-firefox-0.13.0.xpi"]
        self.assertTrue(xpi.startswith(b"PK\x03\x04"))
        self.assertIn("manifest.json", d.zip_files(xpi, "fixture XPI"))
        self.assertNotIn("rust/Cargo.toml", package.files)

    def test_optional_updater_is_packaged_without_registering_and_legacy_archives_still_verify(self):
        package = self.package()
        self.assertIn("scripts/auto-update.ps1", package.files)
        self.install(package)
        self.assertEqual((self.install_root / "tools" / "auto-update.ps1").read_bytes(),
                         package.files["scripts/auto-update.ps1"])
        self.assertFalse((self.install_root / "updates").exists())
        (self.source / "scripts" / "auto-update.ps1").unlink()
        native = self.source / "native" / d.native_name(self.target)
        path, _ = d.package_artifact(self.source, native, self.work / "legacy-format", runner=fixture_runner)
        legacy = d.verify_package(path.read_bytes())
        self.assertNotIn("scripts/auto-update.ps1", legacy.files)

    def test_identical_inputs_produce_identical_artifacts(self):
        native = self.fixture_source("0.13.0")
        first, first_descriptor = d.package_artifact(self.source, native, self.work / "a", runner=fixture_runner)
        second, second_descriptor = d.package_artifact(self.source, native, self.work / "b", runner=fixture_runner)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(first_descriptor, second_descriptor)
        with zipfile.ZipFile(first) as archive:
            self.assertTrue(all(entry.date_time == (1980, 1, 1, 0, 0, 0) for entry in archive.infolist()))

    def test_signature_presence_is_unverified_and_safe_zip_directories_are_supported(self):
        native = self.fixture_source("0.13.0")
        directory = self.source / "extension" / "dist" / "firefox"
        body = d.extension_files(directory, "firefox", "0.13.0")
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            folder = zipfile.ZipInfo("META-INF/", (1980, 1, 1, 0, 0, 0))
            folder.create_system = 3
            folder.external_attr = (stat.S_IFDIR | 0o755) << 16
            archive.writestr(folder, b"")
            for name, value in {**body, "META-INF/manifest.mf": b"synthetic metadata",
                                "META-INF/mozilla.rsa": b"fixture only; NOT a Mozilla signature"}.items():
                archive.writestr(name, value)
        xpi = self.work / "synthetic-signature-metadata.xpi"
        self.write(xpi, stream.getvalue())
        path, _ = d.package_artifact(self.source, native, self.work / "signed-fixture",
                                    firefox_xpi=xpi, runner=fixture_runner)
        verified = d.verify_package(path.read_bytes())
        self.assertEqual(verified.manifest["firefoxSigning"], "signature-present-unverified")
        with self.assertRaises(d.DistributionError):
            d.zip_files(stream.getvalue(), "outer distribution must not contain directories")

    def test_corrupted_archive_fails_trusted_hash(self):
        package = self.package()
        corrupted = package.data[:-1] + bytes([package.data[-1] ^ 1])
        with self.assertRaisesRegex(d.DistributionError, "SHA256"):
            d.verify_package(corrupted, expected_sha256=package.digest)

    def test_wrong_version_and_identity_are_refused(self):
        package = self.package()
        with self.assertRaisesRegex(d.DistributionError, "Expected version"):
            d.verify_package(package.data, version="0.14.0")
        for key, bad in (("nativeVersion", "0.12.0"), ("protocolVersion", 2),
                         ("geckoId", "other@example.invalid"), ("repository", "https://github.com/example/project")):
            with self.subTest(key=key):
                manifest = {**package.manifest, key: bad}
                raw = raw_zip({**package.files, "manifest.json": d.json_bytes(manifest)})
                with self.assertRaises(d.DistributionError):
                    d.verify_package(raw)

    def test_traversal_absolute_ads_and_case_collision_are_refused(self):
        package = self.package()
        files = {**package.files, "manifest.json": d.json_bytes(package.manifest)}
        for name in ("../escape", "/absolute", r"..\escape", "C:/escape", "extension/firefox/file:stream",
                     "extension//firefox/extra.js", "extension/firefox/CON", "extension/firefox/popup.html."):
            with self.subTest(name=name):
                with self.assertRaises(d.DistributionError):
                    d.verify_package(raw_zip({**files, name: b"bad"}))
        with self.assertRaisesRegex(d.DistributionError, "case-colliding"):
            d.verify_package(raw_zip({**files, "Extension/firefox/manifest.json": b"collision"}))

    def test_link_payload_and_tar_disguised_as_xpi_are_refused(self):
        package = self.package()
        files = {**package.files, "manifest.json": d.json_bytes(package.manifest)}
        with self.assertRaisesRegex(d.DistributionError, "linked"):
            d.verify_package(raw_zip(files, linked="extension/firefox/background.js"))
        with self.assertRaisesRegex(d.DistributionError, "actual ZIP"):
            d.zip_files(b"not a ZIP; tar disguised with .xpi" * 30, "XPI")

    def test_unexpected_source_secret_file_is_not_packaged(self):
        native = self.fixture_source("0.13.0")
        self.write(self.source / "extension" / "dist" / "firefox" / ".env", "FIXTURE_ONLY=no-secret")
        with self.assertRaisesRegex(d.DistributionError, "unexpected"):
            d.package_artifact(self.source, native, self.work / "a", runner=fixture_runner)

    def test_native_smoke_and_source_version_mismatch_stop_packaging(self):
        native = self.fixture_source("0.13.0")
        native.write_bytes(synthetic_binary("0.12.0", self.target))
        with self.assertRaisesRegex(d.DistributionError, "--version"):
            d.package_artifact(self.source, native, self.work / "a", runner=fixture_runner)
        native = self.fixture_source("0.13.0")
        self.write(self.source / "python" / "pyproject.toml", '[project]\nversion = "0.12.0"')
        with self.assertRaisesRegex(d.DistributionError, "not aligned"):
            d.package_artifact(self.source, native, self.work / "b", runner=fixture_runner)

    def test_executable_platform_and_architecture_match_package(self):
        for target in sorted(d.TARGETS):
            with self.subTest(target=target):
                d.check_native_format(synthetic_binary("0.13.0", target), target)
                other = target.replace("x86_64", "aarch64") if target.endswith("x86_64") else target.replace("aarch64", "x86_64")
                with self.assertRaises(d.DistributionError):
                    d.check_native_format(synthetic_binary("0.13.0", other), target)

    def test_descriptor_size_manifest_hash_and_filename_must_match(self):
        package = self.package()
        with self.assertRaisesRegex(d.DistributionError, "size"):
            d.verify_package(package.data, expected_size=len(package.data) + 1)
        with self.assertRaisesRegex(d.DistributionError, "manifest SHA256"):
            d.verify_package(package.data, expected_manifest_sha256="0" * 64)
        path = self.work / "package.zip"
        self.write(path, package.data)
        with self.assertRaisesRegex(d.DistributionError, "Supply --sha256"):
            d.package_from_path(path)
        manifest = {**package.manifest, "file": "wrong.zip", "size": len(package.data), "sha256": package.digest, "manifestSha256": package.manifest_digest}
        self.write(path.with_suffix(".json"), d.json_bytes(manifest))
        with self.assertRaisesRegex(d.DistributionError, "filename"):
            d.package_from_path(path)

    def test_same_version_artifact_cannot_be_overwritten(self):
        native = self.fixture_source("0.13.0")
        output = self.work / "out"
        d.package_artifact(self.source, native, output, runner=fixture_runner)
        native.write_bytes(native.read_bytes() + b"DIFFERENT")
        with self.assertRaisesRegex(d.DistributionError, "same version"):
            d.package_artifact(self.source, native, output, runner=fixture_runner)

    def test_version_and_json_validation_is_canonical(self):
        for value in ("v0.13.0", "00.13.0", "0.13", "0.13.0-beta", "0.13.0\n", "9007199254740992.0.0"):
            with self.subTest(value=value):
                with self.assertRaises(d.DistributionError):
                    d.version_tuple(value)
        with self.assertRaisesRegex(d.DistributionError, "Duplicate"):
            d.parse_json(b'{"version":"0.13.0","version":"0.12.0"}', "fixture")

    @unittest.skipUnless(os.name == "nt", "PowerShell wrapper validation is Windows-only")
    def test_powershell_validate_only_never_installs_synthetic_binary(self):
        self.package()
        path = self.work / "output-0.13.0" / f"browser-bridge-0.13.0-{self.target}.zip"
        for version, expected in (("0.13.0", 0), ("0.14.0", 1)):
            with self.subTest(version=version):
                result = subprocess.run([
                    "powershell", "-NoProfile", "-NonInteractive", "-File", str(REPO / "scripts" / "install.ps1"),
                    "-ValidateOnly", "-PrebuiltPackage", str(path), "-ExpectedVersion", version,
                    "-InstallRoot", str(self.work / "never-installed"),
                ], capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode == 0, expected == 0, result.stdout + result.stderr)
                self.assertFalse((self.work / "never-installed").exists())

    @unittest.skipIf(os.name == "nt" or not Path("/bin/bash").is_file(), "POSIX wrapper validation uses the system Bash")
    def test_posix_wrapper_forwards_install_with_and_without_optional_arguments(self):
        # macOS ships Bash 3.2, where an empty array expansion under `set -u` is an error.
        record = self.work / "arguments.txt"
        python = self.work / "python-stub"
        self.write(python, '#!/bin/sh\n[ "$1" = "-c" ] && exit 0\n'
                   'for argument in "$@"; do printf \'%s\\n\' "$argument"; done > "$RECORD"\n')
        python.chmod(0o755)
        package = self.work / f"browser-bridge-0.13.0-{self.target}.zip"
        self.write(package, b"synthetic package; the stub never opens it")
        for extra in ([], ["--read-only", "--agent", "copilot"]):
            with self.subTest(extra=extra):
                record.unlink(missing_ok=True)
                result = subprocess.run([
                    "/bin/bash", str(REPO / "scripts" / "install.sh"), "--prebuilt-package", str(package),
                    "--install-root", str(self.install_root), *extra,
                ], env={**os.environ, "BROWSER_BRIDGE_PYTHON": str(python), "RECORD": str(record)},
                    capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(record.read_text().splitlines(), [
                    str(REPO / "scripts" / "distribution.py"), "install", "--package", str(package),
                    "--install-root", str(self.install_root), "--browser", "firefox", *extra])
                self.assertFalse(self.install_root.exists())


class ConfigTests(FixtureCase):
    def test_copilot_preserves_tools_env_unknown_fields_and_policy(self):
        _, original = self.copilot()
        executable = self.work / "new" / d.native_name(self.target)
        merged = json.loads(merge_json_config(d.json_bytes(original), "copilot", executable))
        expected = copy.deepcopy(original)
        expected["mcpServers"]["browser-bridge"]["command"] = str(executable)
        self.assertEqual(merged, expected)

    def test_claude_unknown_global_fields_remain_unchanged(self):
        original = {"projects": {"fixture": {"hasTrustDialogAccepted": False}}, "unknown": [1, 2],
                    "mcpServers": {"other": {"command": "something"}}}
        updated = json.loads(merge_json_config(d.json_bytes(original), "claude", self.work / "BrowserBridge.exe"))
        self.assertEqual(updated["projects"], original["projects"])
        self.assertEqual(updated["mcpServers"]["other"], original["mcpServers"]["other"])
        self.assertEqual(updated["mcpServers"]["browser-bridge"]["args"], ["mcp", "--read-only"])
        self.assertNotIn("env", updated["mcpServers"]["browser-bridge"])

    def test_explicit_policy_updates_only_managed_flags(self):
        _, original = self.copilot()
        updated = json.loads(merge_json_config(d.json_bytes(original), "copilot", self.work / "BrowserBridge.exe", False, False))
        entry = updated["mcpServers"]["browser-bridge"]
        self.assertEqual(entry["args"], ["mcp", "--custom-flag"])
        self.assertEqual(entry["tools"], ["browser_tabs"])
        self.assertEqual(entry["env"], {"EXTRA_SETTING": "preserve-me"})

    def test_codex_multiline_args_comments_env_and_unknown_tables_are_preserved(self):
        text = (
            '# Preserve this comment.\nmodel = "fixture"\n'
            '[mcp_servers.other]\ncommand = "other"\n'
            '[mcp_servers."browser-bridge"]\ncommand = "BrowserBridge.exe"\nargs = [\n'
            '  "mcp",\n  "--read-only",\n  "--allow-evaluate",\n  "--custom-flag",\n]\n'
            'enabled_tools = ["browser_tabs"]\nstartup_timeout_sec = 19\n'
            '[mcp_servers."browser-bridge".env]\nEXTRA_SETTING = "preserve-me"\n'
            '[unrelated]\nunknown = { inner = 7 }\n'
        )
        executable = self.work / "new" / "BrowserBridge.exe"
        updated = merge_codex_config(text.encode(), executable).decode()
        expected = tomllib.loads(text)
        expected["mcp_servers"]["browser-bridge"]["command"] = str(executable)
        self.assertEqual(tomllib.loads(updated), expected)
        self.assertTrue(updated.startswith('# Preserve this comment.\nmodel = "fixture"\n'))
        self.assertIn('[mcp_servers."browser-bridge".env]\nEXTRA_SETTING = "preserve-me"', updated)
        self.assertTrue(updated.endswith('[unrelated]\nunknown = { inner = 7 }\n'))

    def test_codex_new_entry_defaults_to_read_only(self):
        original = b'# Keep\nmodel = "fixture"\n'
        result = merge_codex_config(original, self.work / "BrowserBridge.exe")
        self.assertTrue(result.startswith(original))
        self.assertEqual(tomllib.loads(result.decode())["mcp_servers"]["browser-bridge"]["args"], ["mcp", "--read-only"])

    def test_conflicting_remote_or_unknown_command_and_bad_json_are_refused(self):
        for entry in ({"url": "https://example.invalid/mcp", "type": "http"}, {"command": "other", "args": ["mcp"]}):
            with self.subTest(entry=entry):
                with self.assertRaises(ConfigError):
                    merge_json_config(d.json_bytes({"mcpServers": {"browser-bridge": entry}}), "copilot", self.work / "BrowserBridge.exe")
        for content in (b"invalid", b'{"mcpServers":{},"mcpServers":{}}', b'{"mcpServers":[]}'):
            with self.assertRaises(ConfigError):
                merge_json_config(content, "copilot", self.work / "BrowserBridge.exe")

    def test_codex_inline_entry_is_refused_without_losing_it(self):
        with self.assertRaisesRegex(ConfigError, "inline/dotted"):
            merge_codex_config(b'[mcp_servers]\nbrowser-bridge = { command = "BrowserBridge.exe", args = ["mcp"] }\n',
                               self.work / "BrowserBridge.exe")


class InstallationTests(FixtureCase):
    def test_install_validates_binary_before_any_configuration_swap(self):
        package = self.package()
        path, _ = self.copilot()
        old_binary = self.install_root / "app" / d.native_name(self.target)
        self.write(old_binary, b"previous-good-legacy-copy")
        before = path.read_bytes()
        with self.assertRaisesRegex(d.DistributionError, "--version"):
            self.install(package, agents=[{"target": "copilot", "path": str(path)}],
                         runner=lambda executable, args: "0.12.0")
        self.assertEqual(old_binary.read_bytes(), b"previous-good-legacy-copy")
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.install_root / "managed.json").exists())

    def test_install_preserves_unrelated_agent_and_app_files(self):
        package = self.package()
        unrelated = self.work / "agents" / "unselected.json"
        self.write(unrelated, b'{"unknown":true}')
        self.write(self.install_root / "app" / "user-file.txt", b"preserve")
        state = self.install(package)
        self.assertEqual(state["agents"], [])
        self.assertEqual(unrelated.read_bytes(), b'{"unknown":true}')
        self.assertEqual((self.install_root / "app" / "user-file.txt").read_bytes(), b"preserve")
        registration = json.loads((self.install_root / ".fixture-native" / "firefox.json").read_bytes())
        self.assertIn("releases", registration["path"])
        self.assertEqual(registration["allowed_extensions"], [d.GECKO_ID])

    def test_registration_failure_restores_previous_host_extension_and_metadata(self):
        self.install(self.package("0.12.0"))
        root = self.install_root
        before = {path: path.read_bytes() for path in (
            root / "app" / d.native_name(self.target), root / "extension" / "firefox" / "manifest.json",
            root / ".fixture-native" / "firefox.json", root / "managed.json",
        )}
        def failing(transaction, install_root, executable, browsers):
            fixture_register(transaction, install_root, executable, browsers)
            raise d.DistributionError("Synthetic registration failure")
        with self.assertRaisesRegex(d.DistributionError, "registration failure"):
            self.install(self.package("0.13.0"), register=failing)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)

    def test_post_swap_failure_rolls_back_agent_configs_as_well(self):
        path, _ = self.copilot()
        self.install(self.package("0.12.0"), agents=[{"target": "copilot", "path": str(path)}])
        before = path.read_bytes()
        metadata = (self.install_root / "managed.json").read_bytes()
        def fail_post_swap(executable, args):
            version = fixture_runner(executable, args)
            if executable == self.install_root / "app" / d.native_name(self.target) and args == ["--version"] and version == "0.13.0":
                raise d.DistributionError("Synthetic post-swap smoke failure")
            return version
        with self.assertRaisesRegex(d.DistributionError, "post-swap"):
            self.install(self.package("0.13.0"), runner=fail_post_swap)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual((self.install_root / "managed.json").read_bytes(), metadata)
        self.assertEqual(fixture_runner(self.install_root / "app" / d.native_name(self.target), ["--version"]), "0.12.0")

    def test_concurrent_agent_edit_is_preserved_while_other_changes_roll_back(self):
        path, _ = self.copilot()
        self.install(self.package("0.12.0"), agents=[{"target": "copilot", "path": str(path)}])
        external = path.read_bytes() + b" \n"
        def concurrent(transaction, root, executable, browsers):
            fixture_register(transaction, root, executable, browsers)
            path.write_bytes(external)
        with self.assertRaisesRegex(d.DistributionError, "changed during installation"):
            self.install(self.package("0.13.0"), register=concurrent)
        self.assertEqual(path.read_bytes(), external)
        self.assertEqual(d.read_state(self.install_root)["version"], "0.12.0")

    def test_rollback_revalidates_package_and_preserves_current_agent_policy(self):
        path, original = self.copilot()
        self.install(self.package("0.12.0"), agents=[{"target": "copilot", "path": str(path)}])
        self.install(self.package("0.13.0"), read_only=False, allow_evaluate=False)
        state = d.rollback_install(self.install_root, runner=fixture_runner, register=fixture_register)
        self.assertEqual(state["version"], "0.12.0")
        merged = json.loads(path.read_bytes())
        entry = merged["mcpServers"]["browser-bridge"]
        self.assertEqual(entry["args"], ["mcp", "--custom-flag"])
        self.assertEqual(entry["env"], original["mcpServers"]["browser-bridge"]["env"])
        self.assertEqual(merged["mcpServers"]["other-tool"], original["mcpServers"]["other-tool"])

    def test_pin_is_preserved_and_conflicting_update_or_rollback_is_refused(self):
        self.install(self.package("0.12.0"))
        d.set_pin(self.install_root, "0.12.0")
        with self.assertRaisesRegex(d.DistributionError, "pinned"):
            self.install(self.package("0.13.0"))
        self.assertEqual(d.read_state(self.install_root)["pinnedVersion"], "0.12.0")
        d.set_pin(self.install_root, None)
        self.install(self.package("0.13.0"))
        d.set_pin(self.install_root, "0.13.0")
        with self.assertRaisesRegex(d.DistributionError, "pinned"):
            d.rollback_install(self.install_root, runner=fixture_runner, register=fixture_register)
        d.set_pin(self.install_root, None)
        self.assertEqual(d.rollback_install(self.install_root, runner=fixture_runner, register=fixture_register)["version"], "0.12.0")

    def test_corrupt_retained_rollback_package_is_refused(self):
        self.install(self.package("0.12.0"))
        state = self.install(self.package("0.13.0"))
        retained = self.install_root.joinpath(*state["previous"]["packageFile"].split("/"))
        retained.write_bytes(b"corrupted")
        with self.assertRaisesRegex(d.DistributionError, "SHA256"):
            d.rollback_install(self.install_root, runner=fixture_runner, register=fixture_register)
        self.assertEqual(d.read_state(self.install_root)["version"], "0.13.0")

    def test_native_locked_file_failure_is_reported_without_stopping_processes(self):
        first = self.package("0.12.0")
        self.install(first)
        previous = (self.install_root / "app" / d.native_name(self.target)).read_bytes()
        real_write = d.atomic_write
        def locked(path, data, mode=0o600):
            if path == self.install_root / "app" / d.native_name(self.target):
                raise PermissionError("Synthetic locked executable")
            return real_write(path, data, mode)
        with mock.patch.object(d, "atomic_write", side_effect=locked):
            with self.assertRaisesRegex(PermissionError, "locked executable"):
                self.install(self.package("0.13.0"))
        self.assertEqual((self.install_root / "app" / d.native_name(self.target)).read_bytes(), previous)

    def test_repair_reconciles_stable_copies_from_committed_verified_package(self):
        self.install(self.package())
        stable = self.install_root / "app" / d.native_name(self.target)
        stable.write_bytes(b"interrupted copy")
        d.repair_install(self.install_root, runner=fixture_runner, register=fixture_register)
        self.assertEqual(fixture_runner(stable, ["--version"]), "0.13.0")

    def test_same_installed_version_with_different_bytes_is_refused(self):
        first = self.package()
        self.install(first)
        native = self.fixture_source("0.13.0")
        native.write_bytes(native.read_bytes() + b"different")
        path, _ = d.package_artifact(self.source, native, self.work / "different-output", runner=fixture_runner)
        with self.assertRaisesRegex(d.DistributionError, "same installed release"):
            self.install(d.verify_package(path.read_bytes()))

    def test_connected_minor_mismatch_warns_without_killing_or_restarting(self):
        package = self.package()
        def connected(executable, args):
            if args == ["status", "--json"]:
                return json.dumps({"browsers": [{"browser": "firefox", "extensionVersion": "0.12.0"}]})
            return fixture_runner(executable, args)
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            state = self.install(package, runner=connected)
        self.assertEqual(state["version"], "0.13.0")
        self.assertIn("does not match native", output.getvalue())
        self.assertIn("Reload", output.getvalue())


class UpdateTests(FixtureCase):
    def test_url_origin_project_route_credentials_and_cdn_redirect_validation(self):
        good_api = d.API + "/releases/latest"
        good_asset = d.REPOSITORY + "/releases/download/v0.13.0/browser-bridge-0.13.0-linux-x86_64.zip"
        self.assertEqual(d.trusted_url(good_api), good_api)
        self.assertEqual(d.trusted_url(good_asset), good_asset)
        for url in (
            "https://github.com/other/browser-bridge/releases/download/v0.13.0/file.zip",
            "http://api.github.com/repos/dcluomax/browser-bridge/releases/latest",
            "https://api.github.com.evil.invalid/repos/dcluomax/browser-bridge/releases/latest",
            "https://user:example@api.github.com/repos/dcluomax/browser-bridge/releases/latest",
            good_api + "?token=fixture", good_api + "#fragment",
            d.API_ORIGIN + "/repos/other/project/releases/latest",
            d.REPOSITORY + "/releases/download/v0.13.0/../escape.zip",
            d.REPOSITORY + "/releases/download/v0.13.0/%2e%2e/escape.zip",
            d.REPOSITORY + r"/releases/download/v0.13.0/\escape.zip",
        ):
            with self.subTest(url=url):
                with self.assertRaises(d.DistributionError):
                    d.trusted_url(url)

        handler = d.SafeGitHubRedirect()
        asset_req = urllib.request.Request(good_asset, headers={"Authorization": "Bearer fixture-token", "User-Agent": "test"})
        cdn_req = handler.redirect_request(
            asset_req, None, 302, "Found", {},
            "https://objects.githubusercontent.com/github-production-release-asset/blob?sig=1",
        )
        self.assertIsNone(cdn_req.get_header("Authorization"))
        with self.assertRaises(d.DistributionError):
            handler.redirect_request(cdn_req, None, 302, "Found", {}, "https://objects.githubusercontent.com/second-hop")
        api_req = urllib.request.Request(good_api)
        with self.assertRaises(d.DistributionError):
            handler.redirect_request(api_req, None, 302, "Found", {}, "https://objects.githubusercontent.com/api-hop")
        with self.assertRaises(d.DistributionError):
            handler.redirect_request(asset_req, None, 302, "Found", {}, "https://evil.example/payload.zip")

    def test_missing_release_is_explicit(self):
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError(d.API, 404, "Not Found", {}, None)
        with mock.patch.object(d.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(d.DistributionError, "unavailable.*404"):
                d.http_get(d.API + "/releases/latest", d.MAX_JSON)
        self.assertEqual(opener.open.call_count, 1)

    def test_verified_apply_preserves_agent_fields(self):
        path, original = self.copilot()
        self.install(self.package("0.12.0"), agents=[{"target": "copilot", "path": str(path)}])
        package = self.package("0.13.0")
        _, _, _, requests, fetch = self.remote(package)
        state = d.apply_update(self.install_root, fetch=fetch, runner=fixture_runner, register=fixture_register)
        self.assertEqual(state["version"], "0.13.0")
        self.assertTrue(all(url.startswith((d.ORIGIN, d.API_ORIGIN)) for url in requests))
        merged = json.loads(path.read_bytes())
        entry = merged["mcpServers"]["browser-bridge"]
        self.assertEqual(entry["env"], original["mcpServers"]["browser-bridge"]["env"])
        self.assertEqual(entry["tools"], ["browser_tabs"])

    def test_corrupt_remote_package_is_refused_before_install(self):
        self.install(self.package("0.12.0"))
        package = self.package("0.13.0")
        _, release, contents, _, fetch = self.remote(package)
        url = release["assets"][1]["browser_download_url"]
        contents[url] = package.data[:-1] + bytes([package.data[-1] ^ 1])
        with self.assertRaisesRegex(d.DistributionError, "SHA256"):
            d.apply_update(self.install_root, fetch=fetch, runner=fixture_runner, register=fixture_register)
        self.assertEqual(d.read_state(self.install_root)["version"], "0.12.0")

    def test_wrong_asset_origin_is_refused_without_downloading_it(self):
        package = self.package()
        _, release, contents, requests, fetch = self.remote(package)
        release["assets"][1]["browser_download_url"] = "https://github.com/example/other.zip"
        contents[d.API + "/releases/latest"] = d.json_bytes(release)
        with self.assertRaises(d.DistributionError):
            d.remote_release(self.target, fetch=fetch)
        self.assertEqual(requests, [d.API + "/releases/latest"])

    def test_descriptor_wrong_version_or_size_is_refused(self):
        for field, value in (("version", "0.12.0"), ("size", 1), ("geckoId", "other@example.invalid")):
            with self.subTest(field=field):
                package = self.package()
                descriptor, release, contents, requests, fetch = self.remote(package)
                descriptor[field] = value
                url = release["assets"][0]["browser_download_url"]
                contents[url] = d.json_bytes(descriptor)
                release["assets"][0]["size"] = len(contents[url])
                contents[d.API + "/releases/latest"] = d.json_bytes(release)
                with self.assertRaises(d.DistributionError):
                    d.remote_release(self.target, fetch=fetch)
                self.assertEqual(len(requests), 2)

    def test_idle_apply_is_bounded_and_refuses_connected_browser_before_fetch(self):
        self.install(self.package("0.12.0"))
        fetch = mock.Mock()
        def connected(executable, args):
            return json.dumps({"browsers": [{"browser": "firefox"}]}) if args == ["status", "--json"] else fixture_runner(executable, args)
        with self.assertRaisesRegex(d.DistributionError, "Idle update refused"):
            d.apply_update(self.install_root, require_idle=True, fetch=fetch, runner=connected, register=fixture_register)
        fetch.assert_not_called()

    def test_automatic_apply_rechecks_idle_under_lock_before_any_swap(self):
        self.install(self.package("0.12.0"))
        original = (self.install_root / "managed.json").read_bytes()
        package = self.package("0.13.0")
        _, _, _, _, fetch = self.remote(package)
        probes = []
        def late_session(executable, args):
            if args == ["status", "--json"]:
                probes.append(executable)
                browsers = [] if len(probes) == 1 else [{"browser": "firefox", "extensionVersion": "0.12.0"}]
                return json.dumps({"browsers": browsers})
            return fixture_runner(executable, args)
        with self.assertRaises(d.IdleUpdateSkipped):
            d.apply_update(self.install_root, require_idle=True, fetch=fetch,
                           runner=late_session, register=fixture_register)
        self.assertEqual(len(probes), 2)
        self.assertEqual((self.install_root / "managed.json").read_bytes(), original)
        self.assertEqual(fixture_runner(self.install_root / "app" / d.native_name(self.target), ["--version"]), "0.12.0")

    def test_idle_guard_refuses_reported_agent_sessions_and_unknown_status(self):
        state = {"releaseDirectory": "releases/fixture", "target": self.target, "version": "0.13.0"}
        for status in ({"browsers": [], "activeSessions": 1}, {"browsers": [], "sessions": ["agent"]},
                       {"browsers": [], "active_sessions": False}, {"unrecognized": True}):
            with self.subTest(status=status):
                runner = lambda executable, args: "0.13.0" if args == ["--version"] else json.dumps(status)
                with self.assertRaises(d.IdleUpdateSkipped):
                    d.assert_update_idle(self.install_root, state, runner)

    def test_automatic_apply_never_downgrades(self):
        self.install(self.package("0.13.0"))
        _, _, _, _, fetch = self.remote(self.package("0.12.0"))
        with self.assertRaisesRegex(d.DistributionError, "downgrade"):
            d.apply_update(self.install_root, require_idle=True, fetch=fetch,
                           runner=fixture_runner, register=fixture_register)
        self.assertEqual(d.read_state(self.install_root)["version"], "0.13.0")

    def test_idle_skip_has_distinct_cli_exit_code(self):
        errors = io.StringIO()
        with mock.patch.object(d, "apply_update", side_effect=d.IdleUpdateSkipped("Idle update refused: active session")):
            with contextlib.redirect_stderr(errors):
                code = d.main(["apply", "--require-idle", "--install-root", str(self.install_root)])
        self.assertEqual(code, 3)
        self.assertIn("SKIPPED:", errors.getvalue())

    def test_pin_requests_only_exact_tag(self):
        package = self.package("0.13.0")
        self.install(package)
        d.set_pin(self.install_root, "0.13.0")
        _, _, _, requests, fetch = self.remote(package)
        result = d.check_update(self.install_root, fetch=fetch)
        self.assertFalse(result["updateAvailable"])
        self.assertEqual(requests[0], d.API + "/releases/tags/v0.13.0")
        with self.assertRaisesRegex(d.DistributionError, "pinned"):
            d.check_update(self.install_root, "0.14.0", fetch=fetch)
        state = d.apply_update(self.install_root, require_idle=True, fetch=fetch,
                               runner=fixture_runner, register=fixture_register)
        self.assertEqual(state["pinnedVersion"], "0.13.0")
        self.assertEqual(state["version"], "0.13.0")

    def test_local_path_rejects_traversal_network_and_ads(self):
        for path in ("../escape", r"..\escape", r"\\server\share\file", "bad\npath", "bad*path"):
            with self.subTest(path=path):
                with self.assertRaises(d.DistributionError):
                    d.local_path(path)
        if os.name == "nt":
            for path in (r"C:\projects\file:stream", r"C:\projects\CON", r"C:\projects\trailing.",
                         r".\..\escape", r".\CON", r".\file:stream", r".\trailing.",
                         r".\directory.\file", ".\\trailing \\file"):
                with self.assertRaises(d.DistributionError):
                    d.local_path(path)

    def test_current_directory_components_are_not_reserved_filenames(self):
        self.assertEqual(d.local_path("."), Path.cwd())
        file = self.work / "fixture.bin"
        self.write(file, b"path fixture, not an executable")
        separator = "\\" if os.name == "nt" else "/"
        relative = str(self.work.relative_to(Path.cwd()))
        for value in (f".{separator}{relative}{separator}fixture.bin",
                      f".{separator}{relative}{separator}.{separator}fixture.bin"):
            with self.subTest(value=value):
                self.assertEqual(d.local_path(value, file=True), file)


class FakeSocket:
    def __init__(self, data: bytes):
        self.chunks = [data[:1], data[1:7], data[7:]]
        self.sent = []

    def recv(self, size):
        return self.chunks.pop(0) if self.chunks else b""

    def sendall(self, data):
        self.sent.append(data)


def rdp_packet(value: dict) -> bytes:
    body = json.dumps(value, ensure_ascii=False).encode("utf-8")
    return str(len(body)).encode("ascii") + b":" + body


class FirefoxLauncherTests(FixtureCase):
    def test_install_creates_launcher_but_does_not_open_or_create_profile(self):
        firefox = self.work / ("firefox.exe" if os.name == "nt" else "firefox")
        self.write(firefox, b"synthetic launcher executable; never run")
        state = self.install(self.package(), firefox_dev_launcher=True, firefox_exe=firefox)
        self.assertTrue(state["firefoxDevelopment"]["enabled"])
        launcher, _ = d.development_launcher(self.install_root)
        self.assertTrue(launcher.is_file())
        self.assertFalse((self.install_root / "firefox-development" / "profile").exists())

    def test_dedicated_profile_persists_and_no_signing_preference_is_changed(self):
        profile = f.prepare_profile(self.install_root)
        self.write(profile / "cookies.sqlite", b"synthetic dedicated-profile data, not user cookies")
        self.assertEqual(f.prepare_profile(self.install_root), profile)
        self.assertEqual((profile / "cookies.sqlite").read_bytes(), b"synthetic dedicated-profile data, not user cookies")
        prefs = (profile / "user.js").read_text()
        self.assertIn('user_pref("devtools.debugger.force-local", true)', prefs)
        self.assertIn('user_pref("devtools.chrome.enabled", true)', prefs)
        self.assertNotIn("xpinstall.signatures", prefs)
        self.assertNotIn("extensions.install.requireBuiltInCerts", prefs)

    def test_known_legacy_debugger_preferences_upgrade_without_copying_or_clearing_profile(self):
        profile = f.prepare_profile(self.install_root)
        marker = profile / ".browser-bridge-development-profile.json"
        metadata = json.loads(marker.read_bytes())
        metadata["preferencesSha256"] = d.sha256(f.LEGACY_PREFERENCES)
        self.write(marker, d.json_bytes(metadata))
        self.write(profile / "user.js", f.LEGACY_PREFERENCES)
        self.write(profile / "cookies.sqlite", b"synthetic dedicated data")
        self.assertEqual(f.prepare_profile(self.install_root), profile)
        self.assertEqual((profile / "user.js").read_bytes(), f.PREFERENCES)
        self.assertEqual(json.loads(marker.read_bytes())["preferencesSha256"], d.sha256(f.PREFERENCES))
        self.assertEqual((profile / "cookies.sqlite").read_bytes(), b"synthetic dedicated data")

    def test_legacy_profile_with_modified_preferences_is_not_migrated(self):
        profile = f.prepare_profile(self.install_root)
        marker = profile / ".browser-bridge-development-profile.json"
        metadata = json.loads(marker.read_bytes())
        metadata["preferencesSha256"] = d.sha256(f.LEGACY_PREFERENCES)
        self.write(marker, d.json_bytes(metadata))
        changed = f.LEGACY_PREFERENCES.replace(b'"devtools.debugger.force-local", true', b'"devtools.debugger.force-local", false')
        self.write(profile / "user.js", changed)
        with self.assertRaises(d.DistributionError):
            f.prepare_profile(self.install_root)
        self.assertEqual((profile / "user.js").read_bytes(), changed)
        self.assertEqual(json.loads(marker.read_bytes()), metadata)

    def test_legacy_preference_migration_rolls_back_if_marker_write_fails(self):
        profile = f.prepare_profile(self.install_root)
        marker = profile / ".browser-bridge-development-profile.json"
        metadata = json.loads(marker.read_bytes())
        metadata["preferencesSha256"] = d.sha256(f.LEGACY_PREFERENCES)
        self.write(marker, d.json_bytes(metadata))
        self.write(profile / "user.js", f.LEGACY_PREFERENCES)
        write = d.atomic_write
        def fail_marker(path, data, mode=0o600):
            if path == marker:
                raise PermissionError("Synthetic marker write failure")
            return write(path, data, mode)
        with mock.patch.object(d, "atomic_write", side_effect=fail_marker):
            with self.assertRaisesRegex(PermissionError, "marker write"):
                f.prepare_profile(self.install_root)
        self.assertEqual((profile / "user.js").read_bytes(), f.LEGACY_PREFERENCES)
        self.assertEqual(json.loads(marker.read_bytes()), metadata)

    def test_launcher_refuses_custom_user_profile_and_modified_installed_xpi(self):
        firefox = self.work / ("firefox.exe" if os.name == "nt" else "firefox")
        self.write(firefox, b"synthetic launcher executable; never run")
        state = self.install(self.package(), firefox_dev_launcher=True, firefox_exe=firefox)
        with mock.patch.object(f, "smoke_native", side_effect=lambda executable, version: d.smoke_native(executable, version, fixture_runner)):
            f.launch_inputs(self.install_root)
            state["firefoxDevelopment"]["profile"] = str(self.work / "not-a-managed-profile")
            self.write(self.install_root / "managed.json", d.json_bytes(state))
            with self.assertRaisesRegex(d.DistributionError, "custom or user Firefox profile"):
                f.launch_inputs(self.install_root)
            state["firefoxDevelopment"]["profile"] = str(self.install_root / "firefox-development" / "profile")
            self.write(self.install_root / "managed.json", d.json_bytes(state))
            xpi = self.install_root / "extension" / "artifacts" / "browser-bridge-firefox-0.13.0.xpi"
            xpi.write_bytes(b"changed")
            with self.assertRaisesRegex(d.DistributionError, "XPI changed"):
                f.launch_inputs(self.install_root)

    def test_firefox_path_cannot_select_an_unrelated_application(self):
        other = self.work / ("other.exe" if os.name == "nt" else "other")
        self.write(other, b"fixture")
        with self.assertRaisesRegex(d.DistributionError, "not another application"):
            d.find_firefox(other)

    def test_unknown_profile_is_never_reused_copied_or_cleared(self):
        profile = self.install_root / "firefox-development" / "profile"
        self.write(profile / "existing-profile.txt", b"must remain")
        with self.assertRaisesRegex(d.DistributionError, "unmarked|without a Browser Bridge marker"):
            f.prepare_profile(self.install_root)
        self.assertEqual((profile / "existing-profile.txt").read_bytes(), b"must remain")
        self.assertFalse((profile / "user.js").exists())

    def test_changed_debugger_preferences_are_refused_not_overwritten(self):
        profile = f.prepare_profile(self.install_root)
        changed = f.PREFERENCES.replace(b'"devtools.debugger.force-local", true', b'"devtools.debugger.force-local", false')
        (profile / "user.js").write_bytes(changed)
        with self.assertRaisesRegex(d.DistributionError, "preferences changed"):
            f.prepare_profile(self.install_root)
        self.assertEqual((profile / "user.js").read_bytes(), changed)

    def test_official_temporary_addon_protocol_uses_utf8_byte_lengths(self):
        data = b"".join([
            rdp_packet({"from": "root", "applicationType": "browser"}),
            rdp_packet({"from": "root", "addonsActor": "addons1"}),
            rdp_packet({"from": "addons1", "addon": {"id": d.GECKO_ID, "name": "桥"}}),
        ])
        connection = FakeSocket(data)
        addon = f.FirefoxDebugger(connection).install_temporary_addon(self.work / "测试.xpi")
        self.assertEqual(addon, d.GECKO_ID)
        self.assertEqual(len(connection.sent), 2)
        for packet in connection.sent:
            length, body = packet.split(b":", 1)
            self.assertEqual(int(length), len(body))
        request = json.loads(connection.sent[1].split(b":", 1)[1])
        self.assertEqual(request["type"], "installTemporaryAddon")
        self.assertEqual(request["addonPath"], str(self.work / "测试.xpi"))

    def test_debugger_invalid_frames_wrong_application_or_addon_id_are_refused(self):
        for packet in (b"invalid:{}", b"1048577:", b"12:{}"):
            with self.subTest(packet=packet):
                with self.assertRaises(d.DistributionError):
                    f.FirefoxDebugger(FakeSocket(packet)).receive()
        with self.assertRaisesRegex(d.DistributionError, "not a Firefox"):
            f.FirefoxDebugger(FakeSocket(rdp_packet({"from": "root", "applicationType": "other"}))).install_temporary_addon(self.work / "x.xpi")
        wrong = b"".join([rdp_packet({"from": "root", "applicationType": "browser"}),
                          rdp_packet({"from": "root", "addonsActor": "a"}),
                          rdp_packet({"from": "a", "addon": {"id": "other@example.invalid"}})])
        with self.assertRaisesRegex(d.DistributionError, "unexpected add-on ID"):
            f.FirefoxDebugger(FakeSocket(wrong)).install_temporary_addon(self.work / "x.xpi")

    def test_debugger_error_does_not_retry_with_signing_disabled(self):
        packets = b"".join([
            rdp_packet({"from": "root", "applicationType": "browser"}),
            rdp_packet({"from": "root", "addonsActor": "a"}),
            rdp_packet({"from": "a", "error": "fixture-install-refused"}),
        ])
        connection = FakeSocket(packets)
        with self.assertRaisesRegex(d.DistributionError, "fixture-install-refused"):
            f.FirefoxDebugger(connection).install_temporary_addon(self.work / "x.xpi")
        self.assertEqual(len(connection.sent), 2)
        self.assertNotIn("signatures.required", f.PREFERENCES.decode())

    def test_firefox_arguments_are_scoped_to_absolute_profile_and_local_port(self):
        profile = self.install_root / "firefox-development" / "profile"
        args = f.firefox_arguments(profile, 34567)
        self.assertEqual(args[args.index("--profile") + 1], str(profile))
        self.assertEqual(args[args.index("--start-debugger-server") + 1], "34567")
        self.assertIn("--no-remote", args)
        self.assertEqual(args[-1], "about:blank")
        with self.assertRaises(d.DistributionError):
            f.firefox_arguments(Path("relative-profile"), 34567)
        with self.assertRaises(d.DistributionError):
            f.firefox_arguments(profile, 80)


if __name__ == "__main__":
    unittest.main()
