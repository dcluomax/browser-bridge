import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAgentPrompt, defaultGuidePath, hostOfUrl, isShareableUrl } from '../src/popup/prompt.ts';

test('builds a single-line minimal prompt with tabId, browser instance, URL, and local guide path', () => {
  const prompt = buildAgentPrompt({
    tabId: 42,
    url: 'https://github.com/example-org/service/pull/104',
    title: 'Fix race condition in retry queue',
    browser: 'edge',
    instanceId: 'a1b2c3d4e5f6',
    agentGuide: 'C:\\Users\\alice\\AppData\\Local\\BrowserBridge\\AGENT.md',
  });
  assert.equal(
    prompt,
    'Browser Bridge tab 42 (edge a1b2c3d4e5f6): https://github.com/example-org/service/pull/104 — read C:\\Users\\alice\\AppData\\Local\\BrowserBridge\\AGENT.md',
  );
  assert.ok(!prompt.includes('\n'));
  assert.ok(prompt.length < 180);
});

test('falls back to OS-appropriate guide path when host has not yet supplied agentGuide', () => {
  assert.equal(defaultGuidePath('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), '%LOCALAPPDATA%\\BrowserBridge\\AGENT.md');
  assert.equal(defaultGuidePath('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), '~/.browser-bridge/AGENT.md');
  const prompt = buildAgentPrompt({
    tabId: 7,
    url: 'https://example.com',
    browser: 'firefox',
    instanceId: 'abcdef012345',
    agentGuide: '',
  });
  assert.match(prompt, /^Browser Bridge tab 7 \(firefox abcdef012345\): https:\/\/example\.com — read /);
});

test('includes optional selection/link focus and access mode inline without adding line breaks', () => {
  const prompt = buildAgentPrompt({
    tabId: 12,
    url: 'https://docs.example.com/roadmap',
    browser: 'edge',
    instanceId: 'a1b2c3d4e5f6',
    agentGuide: 'C:\\AGENT.md',
    mode: 'read',
    focus: 'Action items\nfor Q4',
  });
  assert.equal(
    prompt,
    'Browser Bridge tab 12 [read-only] (edge a1b2c3d4e5f6): https://docs.example.com/roadmap [focus: "Action items for Q4"] — read C:\\AGENT.md',
  );
});

test('allows normal https/http/file/about:blank URLs and blocks browser-internal pages', () => {
  assert.equal(isShareableUrl('https://docs.example.com/roadmap'), true);
  assert.equal(isShareableUrl('http://localhost:3000/app'), true);
  assert.equal(isShareableUrl('file:///C:/Users/alice/notes/spec.html'), true);
  assert.equal(isShareableUrl('about:blank'), true);
  assert.equal(isShareableUrl('edge://extensions'), false);
  assert.equal(isShareableUrl('chrome://newtab/'), false);
  assert.equal(isShareableUrl('about:newtab'), false);
  assert.equal(isShareableUrl('https://microsoftedge.microsoft.com/addons/detail/test'), false);
  assert.equal(isShareableUrl(''), false);
});
