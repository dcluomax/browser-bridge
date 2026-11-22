import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { build } from 'esbuild';

const event = () => {
  const listeners = [];
  return { addListener: (listener) => listeners.push(listener), emit: (...args) => listeners.forEach((listener) => listener(...args)) };
};
const commands = [];
const debuggerApi = {
  onDetach: event(), onEvent: event(), attach: async () => {}, detach: async () => {},
  sendCommand: async (_target, method, params) => {
    commands.push({ method, params });
    if (method === 'Performance.getMetrics') return { metrics: [{ name: 'Nodes', value: 42 }] };
    return {};
  },
};
globalThis.chrome = {
  debugger: debuggerApi,
  storage: { local: { set: async () => {} } },
};
const bundle = await build({
  stdin: {
    contents: "export * from './src/background/developer.ts'; export { updateSettings } from './src/background/settings.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { validateInterceptionRules, matchesInterceptionPattern, runInterception, clearInterception, readDebuggerMetrics, updateSettings } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
await updateSettings({ trustedInput: true });
afterEach(async () => {
  await clearInterception(7);
  commands.length = 0;
});

test('interception refuses wildcard origins, credentials, arbitrary response headers and oversized bodies', () => {
  for (const rule of [
    { urlPattern: 'https://*.test/*', action: 'block' },
    { urlPattern: 'https://user:secret@example.test/*', action: 'block' },
    { urlPattern: 'https://example.test/*?token=value', action: 'block' },
    { urlPattern: 'https://example.test/*', action: 'fulfill', headers: { 'Set-Cookie': 'secret' } },
    { urlPattern: 'https://example.test/*', action: 'fulfill', body: 'x'.repeat(65537) },
    { urlPattern: 'https://example.test/*', action: 'block', body: 'ignored' },
  ]) assert.throws(() => validateInterceptionRules([rule]), (error) => error.code === 'bad_request');
  assert.equal(matchesInterceptionPattern('https://example.test/api/*', 'https://example.test/api/a?x=1'), true);
  assert.equal(matchesInterceptionPattern('https://example.test/api/*', 'https://example.test.attacker/api/a'), false);
  assert.equal(matchesInterceptionPattern('https://example.test/a*b*c', 'https://example.test/axbxc'), true);
  assert.equal(matchesInterceptionPattern('https://example.test/a*b*c', 'https://example.test/axbxc-tail'), false);
  assert.equal(matchesInterceptionPattern('https://example.test/' + '*a'.repeat(1000) + 'z', 'https://example.test/' + 'a'.repeat(2000)), false);
});

test('static mocks use one paused request and preserve UTF-8 bytes without exposing response bodies in list', async () => {
  const body = JSON.stringify({ message: String.fromCodePoint(0x2713) });
  const result = await runInterception(7, 'owner', { action: 'set', rules: [
    { urlPattern: 'https://example.test/api/*', action: 'fulfill', status: 202, body },
  ] });
  assert.equal(result.active, true);
  assert.equal(result.rules[0].body, undefined);
  debuggerApi.onEvent.emit({ tabId: 7 }, 'Fetch.requestPaused', { requestId: 'r1', request: { url: 'https://example.test/api/a' } });
  await new Promise((resolve) => setImmediate(resolve));
  const fulfilled = commands.find((entry) => entry.method === 'Fetch.fulfillRequest');
  assert.equal(fulfilled.params.requestId, 'r1');
  assert.equal(fulfilled.params.responseCode, 202);
  assert.equal(Buffer.from(fulfilled.params.body, 'base64').toString('utf8'), body);
  assert.equal((await runInterception(7, 'owner', { action: 'list' })).handledRequests, 1);
  await assert.rejects(runInterception(7, 'other', { action: 'clear' }), (error) => error.code === 'forbidden');
});

test('debugger metrics are measured counters and do not permit arbitrary CDP', async () => {
  const result = await readDebuggerMetrics(7);
  assert.equal(result.source, 'chrome-debugger-performance');
  assert.deepEqual(result.metrics, [{ name: 'Nodes', value: 42 }]);
  assert.equal(commands.some((entry) => entry.method === 'Runtime.evaluate'), false);
  await updateSettings({ trustedInput: false });
  try {
    await assert.rejects(readDebuggerMetrics(8), (error) => error.code === 'debugger_unavailable');
  } finally {
    await updateSettings({ trustedInput: true });
  }
});
