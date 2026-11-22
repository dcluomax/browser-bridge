"""Mocked Windows scheduler tests; no real task, release, or browser is used."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).absolute().parents[2]
WRAPPER = REPO / "scripts" / "auto-update.ps1"
NS = {"task": "http://schemas.microsoft.com/windows/2004/02/mit/task"}


@unittest.skipUnless(os.name == "nt", "Task Scheduler wrapper is Windows-only")
class AutomaticUpdateTests(unittest.TestCase):
    def setUp(self):
        self.work = Path.cwd() / (".browser-bridge-auto-tests-" + uuid.uuid4().hex)
        self.root = self.work / "root & path"
        (self.root / "tools").mkdir(parents=True)
        self.metadata = {
            "schemaVersion": 1, "project": "browser-bridge",
            "repository": "https://github.com/dcluomax/browser-bridge",
            "nativeHostName": "io.github.dcluomax.browser_bridge", "version": "0.13.0",
            "nativeVersion": "0.13.0", "extensionVersion": "0.13.0",
        }
        (self.root / "managed.json").write_text(json.dumps(self.metadata), encoding="utf-8")
        (self.root / "tools" / "distribution.py").write_text(
            "import json\nSAFE_AUTOMATIC_UPDATE_VERSION = 0\n"
            "if __name__ == '__main__':\n"
            "    print(json.dumps({'installedVersion':'0.13.0','availableVersion':'0.13.0',"
            "'pinnedVersion':'0.13.0','updateAvailable':False}))\n",
            encoding="utf-8",
        )

    def tearDown(self):
        shutil.rmtree(self.work)

    def invoke(self, body: str) -> dict:
        driver = self.work / ("driver-" + uuid.uuid4().hex + ".ps1")
        driver.write_text(
            "param([string]$Wrapper,[string]$Root,[string]$Python)\n"
            ". $Wrapper\n" + body + "\n",
            encoding="utf-8",
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-File", str(driver),
             "-Wrapper", str(WRAPPER), "-Root", str(self.root), "-Python", sys.executable],
            text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = [line for line in result.stdout.splitlines() if line.strip().startswith("{")]
        self.assertTrue(lines, result.stdout + result.stderr)
        return json.loads(lines[-1])

    @staticmethod
    def fake_scheduler() -> str:
        return r"""
$script:folder = [pscustomobject]@{ registerCalls = 0; deleteCalls = 0; savedXml = ''; flags = 0; passwordIsNull = $false; logonType = 0; user = '' }
$script:folder | Add-Member -MemberType ScriptMethod -Name RegisterTask -Value {
    param($name,$xml,$flags,$user,$password,$logon,$sddl)
    $this.registerCalls++; $this.savedXml = $xml; $this.flags = $flags
    $this.user = $user; $this.passwordIsNull = ($null -eq $password); $this.logonType = $logon
}
$script:folder | Add-Member -MemberType ScriptMethod -Name DeleteTask -Value {
    param($name,$flags) $this.deleteCalls++
}
$script:task = $null
function Get-BrowserBridgeTaskFolder { return $script:folder }
function Find-BrowserBridgeUpdateTask { param($Folder,$Plan) return $script:task }
function Assert-BrowserBridgeAutomaticUpdateEngine { param($Plan) }
"""

    def test_plans_are_current_user_least_privilege_no_credentials_or_bypass(self):
        result = self.invoke(r"""
$check = Get-BrowserBridgeUpdatePlan $Root $Python 'Check' 360
$apply = Get-BrowserBridgeUpdatePlan $Root $Python 'Apply' 30
@{ check = $check; apply = $apply } | ConvertTo-Json -Compress -Depth 8
""")
        for mode in ("check", "apply"):
            plan = result[mode]
            xml = ET.fromstring(plan["xml"])
            self.assertIn(plan["ownerSid"], plan["taskName"])
            self.assertEqual(xml.find("task:Principals/task:Principal/task:UserId", NS).text, plan["ownerSid"])
            self.assertEqual(xml.find("task:Principals/task:Principal/task:LogonType", NS).text, "InteractiveToken")
            self.assertEqual(xml.find("task:Principals/task:Principal/task:RunLevel", NS).text, "LeastPrivilege")
            self.assertEqual(xml.find("task:Settings/task:MultipleInstancesPolicy", NS).text, "IgnoreNew")
            self.assertEqual(xml.find("task:Settings/task:ExecutionTimeLimit", NS).text, "PT10M")
            self.assertEqual(xml.find("task:Settings/task:IdleSettings/task:StopOnIdleEnd", NS).text, "false")
            self.assertNotIn("GITHUB_TOKEN", plan["xml"])
            self.assertNotIn("-ExecutionPolicy", plan["arguments"])
            self.assertNotIn("Bypass", plan["arguments"])
            self.assertNotIn("-Command", plan["arguments"])
            self.assertIn(str(self.root), plan["arguments"])
        self.assertEqual(ET.fromstring(result["check"]["xml"]).find("task:Settings/task:RunOnlyIfIdle", NS).text, "false")
        self.assertEqual(ET.fromstring(result["apply"]["xml"]).find("task:Settings/task:RunOnlyIfIdle", NS).text, "true")
        self.assertFalse((self.root / "tools" / "auto-update.ps1").exists())

    def test_whatif_does_not_register_tasks_or_copy_controller(self):
        result = self.invoke(self.fake_scheduler() + r"""
$plan = Get-BrowserBridgeUpdatePlan $Root $Python
$null = Invoke-BrowserBridgeAutoUpdate 'Enable' $plan -WhatIf
@{ calls = $script:folder.registerCalls; copied = (Test-Path -LiteralPath $plan.worker) } | ConvertTo-Json -Compress
""")
        self.assertEqual(result, {"calls": 0, "copied": False})

    def test_mocked_enable_registers_only_its_owned_task_without_password(self):
        result = self.invoke(self.fake_scheduler() + r"""
$plan = Get-BrowserBridgeUpdatePlan $Root $Python 'Apply' 360
$enabled = Invoke-BrowserBridgeAutoUpdate 'Enable' $plan
@{ calls = $script:folder.registerCalls; flags = $script:folder.flags; noPassword = $script:folder.passwordIsNull; logon = $script:folder.logonType; user = $script:folder.user; sid = $plan.ownerSid; enabled = $enabled.enabled } | ConvertTo-Json -Compress
""")
        self.assertEqual(result["calls"], 1)
        self.assertEqual(result["flags"], 2)
        self.assertTrue(result["noPassword"])
        self.assertEqual(result["logon"], 3)
        self.assertEqual(result["user"], result["sid"])
        self.assertTrue(result["enabled"])
        self.assertEqual((self.root / "tools" / "auto-update.ps1").read_bytes(), WRAPPER.read_bytes())

    def test_other_user_or_unmanaged_task_is_not_overwritten_or_removed(self):
        result = self.invoke(self.fake_scheduler() + r"""
$plan = Get-BrowserBridgeUpdatePlan $Root $Python
[xml]$xml = $plan.xml
$xml.Task.Principals.Principal.UserId = 'S-1-5-21-0-0-0-1001'
$script:task = [pscustomobject]@{ Xml = $xml.OuterXml; State = 3; Enabled = $true }
$failures = 0
foreach ($action in @('Enable','Disable')) {
    try { $null = Invoke-BrowserBridgeAutoUpdate $action $plan } catch { $failures++ }
}
@{ failures = $failures; registered = $script:folder.registerCalls; removed = $script:folder.deleteCalls } | ConvertTo-Json -Compress
""")
        self.assertEqual(result, {"failures": 2, "registered": 0, "removed": 0})

    def test_disable_does_not_stop_an_active_owned_worker(self):
        result = self.invoke(self.fake_scheduler() + r"""
$plan = Get-BrowserBridgeUpdatePlan $Root $Python 'Apply'
$script:task = [pscustomobject]@{ Xml = $plan.xml; State = 4; Enabled = $true; LastTaskResult = 0 }
$disabled = Invoke-BrowserBridgeAutoUpdate 'Disable' $plan
@{ enabled = $script:task.Enabled; running = $disabled.running; removed = $script:folder.deleteCalls } | ConvertTo-Json -Compress
""")
        self.assertEqual(result, {"enabled": False, "running": True, "removed": 0})

    def test_apply_uses_require_idle_and_busy_result_is_a_skip(self):
        result = self.invoke(r"""
$script:arguments = @()
function Assert-BrowserBridgeAutomaticUpdateEngine { param($Plan) }
function Invoke-BrowserBridgeUpdatePython {
    param($Plan,$Arguments) $script:arguments = $Arguments
    return [pscustomobject]@{ exitCode = 3; output = ''; error = 'SKIPPED: Idle update refused: active session.' }
}
$plan = Get-BrowserBridgeUpdatePlan $Root $Python 'Apply'
$result = Invoke-BrowserBridgeUpdateRun $plan
@{ result = $result; arguments = $script:arguments } | ConvertTo-Json -Compress -Depth 6
""")
        self.assertEqual(result["result"]["status"], "skipped-active-or-unverified")
        self.assertIn("--require-idle", result["arguments"])
        self.assertIn("apply", result["arguments"])
        receipt = json.loads((self.root / "updates" / "last-run.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["status"], "skipped-active-or-unverified")
        self.assertNotIn("error", receipt)

    def test_feed_auth_failure_is_explicit_and_receipt_contains_no_server_output(self):
        result = self.invoke(r"""
function Invoke-BrowserBridgeUpdatePython {
    param($Plan,$Arguments)
    return [pscustomobject]@{ exitCode = 1; output = ''; error = 'ERROR: GitHub release is unavailable (HTTP 403).' }
}
$plan = Get-BrowserBridgeUpdatePlan $Root $Python 'Check'
try { $null = Invoke-BrowserBridgeUpdateRun $plan; @{ failed = $false } | ConvertTo-Json -Compress }
catch { @{ failed = $true; message = $_.Exception.Message } | ConvertTo-Json -Compress }
""")
        self.assertTrue(result["failed"])
        self.assertIn("403", result["message"])
        receipt = (self.root / "updates" / "last-run.json").read_text(encoding="utf-8")
        self.assertEqual(json.loads(receipt)["status"], "failed")
        self.assertNotIn("403", receipt)
        self.assertNotIn("GITHUB_TOKEN", receipt)

    def test_one_shot_uses_only_a_synthetic_python_helper(self):
        result = self.invoke(r"""
$plan = Get-BrowserBridgeUpdatePlan $Root $Python 'Check'
Invoke-BrowserBridgeUpdateRun $plan | ConvertTo-Json -Compress -Depth 5
""")
        self.assertEqual(result["status"], "completed")
        self.assertFalse(result["updateAvailable"])
        self.assertEqual(result["pinnedVersion"], "0.13.0")
        self.assertEqual(self.metadata, json.loads((self.root / "managed.json").read_text(encoding="utf-8")))

    def test_apply_refuses_an_old_installed_engine_without_idle_recheck_capability(self):
        result = self.invoke(r"""
$plan = Get-BrowserBridgeUpdatePlan $Root $Python 'Apply'
try { $null = Invoke-BrowserBridgeUpdateRun $plan; @{ failed = $false } | ConvertTo-Json -Compress }
catch { @{ failed = $true; message = $_.Exception.Message } | ConvertTo-Json -Compress }
""")
        self.assertTrue(result["failed"])
        self.assertIn("idle-safe automatic update", result["message"])
        self.assertFalse((self.root / "updates" / "last-run.json").exists())

    def test_status_reports_mode_and_only_removes_a_matching_owned_task(self):
        result = self.invoke(self.fake_scheduler() + r"""
$plan = Get-BrowserBridgeUpdatePlan $Root $Python 'Apply'
$script:task = [pscustomobject]@{ Xml = $plan.xml; State = 3; Enabled = $true; LastTaskResult = 1 }
$status = Invoke-BrowserBridgeAutoUpdate 'Status' $plan
$null = Invoke-BrowserBridgeAutoUpdate 'Disable' $plan
@{ status = $status; removed = $script:folder.deleteCalls } | ConvertTo-Json -Compress -Depth 5
""")
        self.assertTrue(result["status"]["enabled"])
        self.assertEqual(result["status"]["mode"], "Apply")
        self.assertEqual(result["status"]["lastTaskResult"], 1)
        self.assertEqual(result["removed"], 1)


if __name__ == "__main__":
    unittest.main()
