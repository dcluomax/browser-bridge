import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromiumExtensionId, chromiumManifest, firefoxManifest } from '../build.mjs';

const config = JSON.parse(readFileSync(new URL('../bridge.config.json', import.meta.url), 'utf8'));

test('chromium id is derived from the pinned public key', () => {
  assert.equal(chromiumExtensionId(config.chromiumPublicKey), config.chromiumExtensionId);
  assert.match(config.chromiumExtensionId, /^[a-p]{32}$/);
});

test('chromium manifest is MV3 with native messaging and a service worker', () => {
  const manifest = chromiumManifest();
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.ok(manifest.permissions.includes('debugger'));
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.key, config.chromiumPublicKey);
});

test('firefox manifest uses a persistent MV2 background and a fixed gecko id', () => {
  const manifest = firefoxManifest();
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.background.persistent, true);
  assert.equal(manifest.browser_specific_settings.gecko.id, config.geckoId);
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.ok(manifest.permissions.includes('<all_urls>'));
});
