import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { build } from 'esbuild';

const tabs = new Map();
let readError;
let onRead;
const localStore = new Map();
const sessionStore = new Map();
const event = () => ({ addListener() {}, removeListener() {} });
globalThis.chrome = {
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: {
    onUpdated: event(), onCreated: event(),
    query: async () => [...tabs.values()],
    get: async (id) => {
      if (readError) throw readError;
      onRead?.(id);
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
      return tabs.get(id);
    },
  },
  webNavigation: { onCommitted: event(), onDOMContentLoaded: event(), onErrorOccurred: event() },
  webRequest: { onHeadersReceived: event(), onResponseStarted: event() },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, localStore.get(k)])),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) localStore.set(k, v); },
    },
    session: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, sessionStore.get(k)])),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v); },
    },
  },
};
const bundle = await build({
  stdin: { contents: "export { TabRegistry } from './src/background/tabs.ts'; export { updateSettings } from './src/background/settings.ts'; export { Commands } from './src/background/commands.ts';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { TabRegistry, updateSettings, Commands } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

beforeEach(async () => {
  tabs.clear();
  localStore.clear();
  sessionStore.clear();
  readError = undefined;
  onRead = undefined;
  await updateSettings({ accessAllTabs: false });
});

function registry() {
  const result = new TabRegistry();
  result.openSession('owner');
  result.openSession('viewer');
  tabs.set(1, { id: 1, title: 'Shared page', url: 'https://example.test/' });
  result.grant(1, 'user', null);
  return result;
}

test('a user-shared tab remains visible while another session owns it', async () => {
  const state = registry();
  await state.requireTab('owner', 1);
  assert.deepEqual(await state.accessibleTabs('viewer'), []);
  assert.equal((await state.sharedTabs('viewer'))[0].id, 1);
  assert.equal(state.canAccess('viewer', 1), false);
  assert.equal(state.ownerLabel('viewer', 1), 'other agent');
  await assert.rejects(state.requireTab('viewer', 1), (error) => error.code === 'forbidden');
  assert.equal(state.grants.get(1).owner, 'owner');
  assert.equal(state.sessions.get('viewer').currentTabId, undefined);
});

test('releasing an owner changes control state without removing the shared row', async () => {
  const state = registry();
  await state.requireTab('owner', 1);
  state.closeSession('owner');
  assert.equal((await state.sharedTabs('viewer'))[0].id, 1);
  assert.equal(state.canAccess('viewer', 1), true);
  assert.equal(state.ownerLabel('viewer', 1), 'shared by user');
});

test('busy agent-private tabs are not exposed as user-shared metadata', async () => {
  const state = registry();
  tabs.set(2, { id: 2, title: 'Agent private', url: 'https://private.test/' });
  state.grant(2, 'agent', 'owner');
  assert.deepEqual((await state.sharedTabs('viewer')).map(tab => tab.id), [1]);
  state.closeSession('owner');
  assert.deepEqual((await state.sharedTabs('viewer')).map(tab => tab.id), [1, 2]);
});

test('all-tabs mode does not add unshared pages to the shared inventory', async () => {
  const state = registry();
  tabs.set(2, { id: 2, title: 'Never shared', url: 'https://private.test/' });
  await updateSettings({ accessAllTabs: true });
  assert.equal((await state.accessibleTabs('viewer')).length, 2);
  assert.deepEqual((await state.sharedTabs('viewer')).map(tab => tab.id), [1]);
});

test('an explicit user share promotes provenance without stealing ownership', async () => {
  const state = registry();
  state.revoke(1);
  state.grant(1, 'agent', 'owner');
  assert.equal((await state.sharedTabs('viewer')).length, 0);
  state.grant(1, 'user', null);
  assert.equal((await state.sharedTabs('viewer'))[0].id, 1);
  assert.equal(state.grants.get(1).source, 'user');
  assert.equal(state.grants.get(1).owner, 'owner');
  assert.equal(state.canAccess('viewer', 1), false);
});

test('unsharing or closing a tab removes it from inventory', async () => {
  const state = registry();
  state.revoke(1);
  assert.deepEqual(await state.sharedTabs('viewer'), []);
  state.grant(1, 'user', null);
  tabs.delete(1);
  assert.deepEqual(await state.sharedTabs('viewer'), []);
  assert.equal(state.grants.has(1), false);
});

test('a failed read is an error, not proof that a shared tab disappeared', async () => {
  const state = registry();
  readError = new Error('Browser tab service is unavailable');
  await assert.rejects(state.sharedTabs('viewer'), (error) => error.code === 'tabs_failed');
  assert.equal(state.grants.has(1), true);
});

test('a share revoked during the browser read cannot leak into the response', async () => {
  const state = registry();
  onRead = () => state.revoke(1);
  assert.deepEqual(await state.sharedTabs('viewer'), []);
});

test('the inventory wire method reports busy metadata without changing legacy list behavior', async () => {
  const state = registry();
  await state.requireTab('owner', 1);
  const commands = new Commands(state);
  const inventory = await commands.run('viewer', 'tabs.inventory', {});
  assert.equal(inventory.tabs[0].tabId, 1);
  assert.equal(inventory.tabs[0].sharedByUser, true);
  assert.equal(inventory.tabs[0].controllable, false);
  assert.equal(inventory.tabs[0].busy, true);
  assert.equal(inventory.tabs[0].access, 'other agent');
  assert.deepEqual((await commands.run('viewer', 'tabs.list', {})).tabs, []);
  assert.equal(state.grants.get(1).owner, 'owner');
});

test('status advertises shared inventory as an additive capability', async () => {
  const state = registry();
  const status = await new Commands(state).run('viewer', 'status', {});
  assert.equal(status.managedApi, 1);
  assert.equal(status.sharedTabInventory, 1);
});

test('user-shared tabs restore across extension reload only when origin still matches', async () => {
  const state = new TabRegistry();
  tabs.set(10, { id: 10, title: 'Same origin', url: 'https://app.example.com/article/1' });
  tabs.set(11, { id: 11, title: 'Different origin', url: 'https://docs.example.com/guide/1' });
  state.grant(10, 'user', null, 'https://app.example.com/article/1');
  state.grant(11, 'user', null, 'https://docs.example.com/guide/1');
  tabs.set(11, { id: 11, title: 'Navigated away', url: 'https://other.example/login' });
  sessionStore.clear();
  const reloaded = new TabRegistry();
  await reloaded.restore();
  assert.equal(reloaded.grants.has(10), true);
  assert.equal(reloaded.grants.get(10).owner, null);
  assert.equal(reloaded.grants.has(11), false);
});

test('read-only shared tab allows inspection and blocks mutating commands', async () => {
  const state = new TabRegistry();
  tabs.set(20, { id: 20, title: 'Read-only doc', url: 'https://wiki.example.com/architecture' });
  state.grant(20, 'user', null, 'https://wiki.example.com/architecture', 'read');
  const commands = new Commands(state);

  const listed = await commands.run('agent-a', 'tabs.list', {});
  assert.equal(listed.tabs[0].mode, 'read');

  await assert.rejects(
    commands.run('agent-a', 'page.click', { tabId: 20, ref: 'e1' }),
    (err) => err.code === 'read_only',
  );
  await assert.rejects(
    commands.run('agent-a', 'page.navigate', { tabId: 20, url: 'https://example.com' }),
    (err) => err.code === 'read_only',
  );
  await assert.rejects(
    commands.run('agent-a', 'tabs.close', { tabId: 20 }),
    (err) => err.code === 'read_only',
  );

  // Promoting to write immediately unlocks mutations on the grant
  state.setMode(20, 'write');
  assert.equal(state.effectiveMode(20), 'write');
});
