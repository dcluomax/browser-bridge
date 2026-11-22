import assert from 'node:assert/strict';
import { test } from 'node:test';
import { majorMinorMatch, parseReleaseVersion, versionMismatchWarning } from '../src/shared/versions.ts';

test('release versions require canonical and safe numeric SemVer', () => {
  assert.deepEqual(parseReleaseVersion('0.13.0'), { major: 0, minor: 13, patch: 0 });
  for (const value of ['v0.13.0', '0.013.0', '0.13.0-beta', '0.13', '9007199254740992.0.0', '', null]) {
    assert.equal(parseReleaseVersion(value), null);
  }
});

test('patch releases match; major and minor mismatches require a reload warning', () => {
  assert.equal(majorMinorMatch('0.13.0', '0.13.2'), true);
  assert.equal(versionMismatchWarning('0.13.0', '0.13.2'), null);
  assert.match(versionMismatchWarning('0.12.0', '0.13.0')!, /reload the extension/);
  assert.match(versionMismatchWarning('1.13.0', '0.13.0')!, /does not match/);
  assert.match(versionMismatchWarning('', '0.13.0')!, /could not verify/);
});
