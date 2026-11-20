import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAgentPrompt, compactUrlForPrompt, defaultGuidePath, hostOfUrl, isShareableUrl } from '../src/popup/prompt.ts';

test('builds an ultra-compact single-line prompt without query-token or file-path bloat', () => {
  const prompt = buildAgentPrompt({
    tabId: 42,
    url: 'https://github.com/example-org/service/pull/104?utm_source=notify&token=longvalue123456',
    title: 'Fix race condition in retry queue',
    browser: 'edge',
    instanceId: 'a1b2c3d4e5f6',
    mode: 'read',
  });
  assert.equal(
    prompt,
    '[Browser Bridge #42 RO edge] Fix race condition in retry queue (github.com)',
  );
  assert.ok(!prompt.includes('\n'));
  assert.ok(!prompt.includes('utm_source'));
  assert.ok(prompt.length < 90);
});

test('strips huge SharePoint/SSO query blobs and falls back to compact host+path when untitled', () => {
  assert.equal(defaultGuidePath('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), '%LOCALAPPDATA%\\BrowserBridge\\AGENT.md');
  assert.equal(defaultGuidePath('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), '~/.browser-bridge/AGENT.md');
  const hugeSharePoint =
    'https://contoso-my.sharepoint.com/:x:/g/personal/user_contoso_com/cQqDu9Ja5SU3Q4?nav=MTVfezAw&xsdata=' +
    'A'.repeat(600);
  const withTitle = buildAgentPrompt({
    tabId: 1671036640,
    url: hugeSharePoint,
    title: 'Golden_Question_Dataset.xlsx',
    browser: 'edge',
    instanceId: 'abcdef012345',
    mode: 'read',
  });
  assert.equal(
    withTitle,
    '[Browser Bridge #1671036640 RO edge] Golden_Question_Dataset.xlsx (contoso-my.sharepoint.com)',
  );
  assert.ok(!withTitle.includes('xsdata'));

  const untitled = buildAgentPrompt({
    tabId: 7,
    url: hugeSharePoint,
    browser: 'firefox',
    instanceId: 'abcdef012345',
  });
  assert.equal(untitled, `[Browser Bridge #7 firefox] ${compactUrlForPrompt(hugeSharePoint)}`);
  assert.ok(!untitled.includes('xsdata'));
});

test('includes optional selection/link focus inline and compacts long focus URLs', () => {
  const prompt = buildAgentPrompt({
    tabId: 12,
    url: 'https://docs.example.com/roadmap',
    title: 'Q4 Roadmap',
    browser: 'edge',
    instanceId: 'a1b2c3d4e5f6',
    mode: 'write',
    focus: 'Action items\nfor "Q4"',
  });
  assert.equal(
    prompt,
    `[Browser Bridge #12 RW edge] Q4 Roadmap (docs.example.com) [focus: "Action items for 'Q4'"]`,
  );

  const linkFocus = buildAgentPrompt({
    tabId: 12,
    url: 'https://docs.example.com/roadmap',
    title: 'Q4 Roadmap',
    browser: 'edge',
    label: 'Work Profile',
    instanceId: 'a1b2c3d4e5f6',
    mode: 'read',
    focus: 'https://docs.example.com/item#access_token=secret123',
  });
  assert.equal(
    linkFocus,
    '[Browser Bridge #12 RO edge:Work-Profile] Q4 Roadmap (docs.example.com) [focus: "docs.example.com/item"]',
  );
  assert.ok(!linkFocus.includes('secret123'));
});

test('never leaks full local directory paths or query tokens on file:// and about:blank URLs', () => {
  const localFileUrl = 'file:///C:/Users/alice/Private%20Folder/My%20Spec.html?secret=999';
  assert.equal(hostOfUrl(localFileUrl), 'My Spec.html');
  const fileWithTitle = buildAgentPrompt({
    tabId: 88,
    url: localFileUrl,
    title: 'Design Spec',
    browser: 'edge',
    instanceId: 'a1b2c3d4e5f6',
    mode: 'read',
  });
  assert.equal(fileWithTitle, '[Browser Bridge #88 RO edge] Design Spec (My Spec.html)');
  assert.ok(!fileWithTitle.includes('alice'));
  assert.ok(!fileWithTitle.includes('secret=999'));

  const blankTab = buildAgentPrompt({
    tabId: 9,
    url: 'about:blank?foo=bar',
    browser: 'chrome',
    instanceId: 'a1b2c3d4e5f6',
    mode: 'write',
  });
  assert.equal(blankTab, '[Browser Bridge #9 RW chrome] about:blank');
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
