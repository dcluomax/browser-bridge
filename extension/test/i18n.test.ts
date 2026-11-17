import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extMessages, isLocaleSetting, resolveLocale } from '../src/shared/i18n.ts';

test('resolves auto locale across Simplified Chinese, Traditional Chinese, Japanese, and English', () => {
  assert.equal(resolveLocale('auto', 'zh-CN'), 'zh-CN');
  assert.equal(resolveLocale('auto', 'zh-Hans-SG'), 'zh-CN');
  assert.equal(resolveLocale('auto', 'zh-TW'), 'zh-TW');
  assert.equal(resolveLocale('auto', 'zh-HK'), 'zh-TW');
  assert.equal(resolveLocale('auto', 'zh-Hant'), 'zh-TW');
  assert.equal(resolveLocale('auto', 'ja-JP'), 'ja');
  assert.equal(resolveLocale('auto', 'en-US'), 'en');
  assert.equal(resolveLocale('auto', 'fr-FR'), 'en');
});

test('explicit locale overrides system language', () => {
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('ja', 'en-US'), 'ja');
  assert.equal(resolveLocale('zh-TW', 'zh-CN'), 'zh-TW');
  assert.equal(isLocaleSetting('zh-CN'), true);
  assert.equal(isLocaleSetting('es'), false);
});

test('every supported locale catalog formats parameterized strings cleanly', () => {
  for (const loc of ['zh-CN', 'en', 'zh-TW', 'ja'] as const) {
    const m = extMessages(loc);
    assert.ok(m.connectedHost('0.5.1', 'Work').includes('0.5.1'));
    assert.ok(m.sharedRo(42).includes('42'));
    assert.ok(m.sharedRw(42).includes('42'));
    assert.ok(m.menuShareRoCopy.length > 0);
    assert.ok(m.toastSavedDownloads('page.png').includes('page.png'));
  }
});
