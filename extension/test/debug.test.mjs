import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { build } from 'esbuild';

const event = () => ({ addListener() {}, removeListener() {} });
const calls = [];
const tabs = new Map([[7, { id: 7, title: 'Fixture', url: 'https://example.test/' }]]);
globalThis.chrome = {
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  runtime: { getManifest: () => ({ version: '0.13.0' }) },
  tabs: {
    onUpdated: event(), onCreated: event(),
    query: async () => [...tabs.values()],
    get: async (id) => tabs.get(id),
  },
  webNavigation: { onCommitted: event(), onDOMContentLoaded: event(), onErrorOccurred: event() },
  webRequest: { onHeadersReceived: event(), onResponseStarted: event() },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
  scripting: {
    executeScript: async (request) => {
      calls.push(request);
      if (request.files) return [];
      return [{ frameId: request.target.frameIds[0], result: await request.func(...request.args) }];
    },
  },
};
const bundle = await build({
  stdin: {
    contents: "export { DebugCommands, debugTarget } from './src/background/debug.ts'; export { TabRegistry } from './src/background/tabs.ts'; export { updateSettings } from './src/background/settings.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { DebugCommands, debugTarget, TabRegistry, updateSettings } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
let registry;
let debug;
beforeEach(async () => {
  calls.length = 0;
  registry = new TabRegistry();
  registry.openSession('owner');
  registry.openSession('other');
  registry.grant(7, 'user', null, 'https://example.test/', 'write');
  debug = new DebugCommands(registry);
  await updateSettings({ accessAllTabs: false, readOnlyMode: false });
  globalThis.__bb = {
    version: '0.13.0',
    debugStyles: (target, options) => ({ documentId: 'document1', target, options, styles: { display: 'block' } }),
    debugBaselineCreate: () => ({ id: 'baseline1', documentId: 'document1', complete: true }),
    debugPatchApply: () => ({ id: 'patch1', documentId: 'document1' }),
    releaseDebugOwner: (owner, documentId) => ({ owner, documentId, patches: { errors: [] } }),
  };
});

test('diagnostics route large frame refs and preserve document-scoped evidence', async () => {
  const result = await debug.run('owner', 'page.styles', { tabId: 7, ref: 'f19327352834e12', properties: ['display'] });
  assert.equal(result.frameId, 19_327_352_834);
  assert.equal(result.documentId, 'document1');
  assert.equal(result.target.ref, 'f19327352834e12');
  assert.equal(calls[0].target.frameIds[0], 19_327_352_834);
  assert.throws(() => debugTarget({ ref: 'f3e1', frameId: 0 }), (error) => error.code === 'bad_request');
  assert.throws(() => debugTarget({ locator: { steps: [{ kind: 'css', value: 'h1' }] }, ref: 'e1' }));
});

test('read-only and shared-tab ownership gates reject mutations before page execution', async () => {
  await assert.rejects(debug.run('owner', 'page.patch', { tabId: 7, action: 'apply', readOnly: true, changes: [] }), (error) => error.code === 'read_only');
  assert.equal(calls.length, 0);
  registry.setMode(7, 'read');
  await assert.rejects(debug.run('owner', 'page.patch', { tabId: 7, action: 'apply', changes: [] }), (error) => error.code === 'read_only');
  assert.equal(calls.length, 0);
  await debug.run('owner', 'page.styles', { tabId: 7 });
  await assert.rejects(debug.run('other', 'page.styles', { tabId: 7 }), (error) => error.code === 'forbidden');
});

test('session cleanup sends owner and original document identity, not live-page patches', async () => {
  await debug.run('owner', 'page.domBaseline', { tabId: 7, action: 'create' });
  calls.length = 0;
  await debug.releaseOwner('owner');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'releaseDebugOwner');
  assert.deepEqual(calls[0].args[1], ['owner', 'document1']);
  await debug.releaseOwner('owner');
  assert.equal(calls.length, 1);
});

test('all-tabs access teardown cleans every tracked document', async () => {
  await debug.run('owner', 'page.domBaseline', { tabId: 7 });
  calls.length = 0;
  await debug.releaseAll();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'releaseDebugOwner');
});

test('patches cannot mix target frames or unsupported fields before applying changes', async () => {
  await assert.rejects(debug.run('owner', 'page.patch', {
    tabId: 7, action: 'apply', changes: [{ target: { ref: 'f3e1' }, styles: { color: 'red' } }],
  }), (error) => error.code === 'bad_request');
  await assert.rejects(debug.run('owner', 'page.patch', {
    tabId: 7, action: 'apply', changes: [{ target: { ref: 'e1' }, html: '<script>bad</script>' }],
  }), (error) => error.code === 'bad_request');
  assert.equal(calls.length, 0);
});

test('validated patch maps reach the page once and preserve null removals', async () => {
  const result = await debug.run('owner', 'page.patch', {
    tabId: 7, action: 'apply',
    changes: [{ target: { ref: 'e1' }, styles: { color: 'red', display: null }, attributes: { title: 'Probe' } }],
  });
  assert.equal(result.id, 'patch1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'debugPatchApply');
  assert.deepEqual(calls[0].args[1][1][0].styles, { color: 'red', display: null });
  await debug.releaseOwner('owner');
});
