import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { build } from 'esbuild';

const event = () => {
  const listeners = [];
  return { addListener: (listener) => listeners.push(listener), emit: (details) => listeners.forEach((listener) => listener(details)) };
};
const webRequest = Object.fromEntries(['onBeforeRequest', 'onSendHeaders', 'onCompleted', 'onHeadersReceived', 'onErrorOccurred'].map((name) => [name, event()]));
globalThis.chrome = { webRequest, runtime: { getManifest: () => ({ version: '0.13.0' }) } };
const bundle = await build({ entryPoints: ['src/background/network.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { startNetworkCapture, readNetworkCapture, exportNetworkHar, dropTabNetworkCapture, dropOwnerNetworkCaptures } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
afterEach(() => dropTabNetworkCapture(7));

test('HAR requires an existing owner-scoped capture and never arms capture', () => {
  assert.throws(() => exportNetworkHar(7, 'owner'), (error) => error.code === 'capture_required');
  startNetworkCapture(7, { owner: 'owner' });
  assert.throws(() => exportNetworkHar(7, 'other'), (error) => error.code === 'forbidden');
  assert.throws(() => startNetworkCapture(7, { owner: 'other', clear: false }), (error) => error.code === 'forbidden');
  assert.throws(() => readNetworkCapture(7, { owner: 'other' }), (error) => error.code === 'forbidden');
  assert.throws(() => exportNetworkHar(7, 'owner', { limit: 0 }), (error) => error.code === 'bad_request');
  for (const maxEntries of [0, 501, NaN]) {
    assert.throws(() => startNetworkCapture(7, { owner: 'owner', maxEntries }), (error) => error.code === 'bad_request');
  }
});

test('HAR contains observed duration and no headers, bodies or URL secrets', () => {
  const now = Date.now;
  Date.now = () => 1000;
  try {
    startNetworkCapture(7, { owner: 'owner' });
    const details = {
      tabId: 7, requestId: 'request1', method: 'POST', type: 'xmlhttprequest',
      url: 'https://user:very-private@example.test/resource?q=very-private#very-private',
      requestBody: { formData: { password: ['very-private'], public: ['also-private'] } },
    };
    webRequest.onBeforeRequest.emit(details);
    webRequest.onSendHeaders.emit({ ...details, requestHeaders: [{ name: 'Authorization', value: 'very-private' }] });
    Date.now = () => 1017;
    webRequest.onCompleted.emit({ ...details, statusCode: 201, responseHeaders: [{ name: 'Set-Cookie', value: 'very-private' }] });
    const before = readNetworkCapture(7);
    const har = exportNetworkHar(7, 'owner');
    const entry = har.log.entries[0];
    assert.equal(har.log.version, '1.2');
    assert.equal(entry.time, 17);
    assert.equal(entry.response.status, 201);
    assert.equal(entry.request.url, 'https://example.test/resource');
    assert.deepEqual(entry.request.headers, []);
    assert.deepEqual(entry.response.cookies, []);
    assert.deepEqual(entry.timings, { send: -1, wait: -1, receive: -1 });
    assert.equal(entry._durationObserved, true);
    assert.equal(entry._statusObserved, true);
    assert.equal(JSON.stringify(har).includes('very-private'), false);
    assert.equal(JSON.stringify(har).includes('also-private'), false);
    assert.deepEqual(readNetworkCapture(7), before);
  } finally {
    Date.now = now;
  }
});

test('bounded HAR reports dropped and incomplete observations instead of claiming completeness', () => {
  startNetworkCapture(7, { owner: 'owner', maxEntries: 10 });
  for (let index = 0; index < 12; index++) {
    webRequest.onBeforeRequest.emit({ tabId: 7, requestId: `request${index}`, method: 'GET', type: 'image', url: `https://example.test/${index}` });
  }
  const har = exportNetworkHar(7, 'owner');
  assert.equal(har.log.entries.length, 10);
  assert.equal(har.log._capture.droppedEntries, 2);
  assert.equal(har.log._capture.truncated, true);
  assert.equal(har.log.entries[0]._statusObserved, false);
  assert.equal(har.log.entries[0]._durationObserved, false);
  dropOwnerNetworkCaptures('owner');
  assert.throws(() => exportNetworkHar(7, 'owner'), (error) => error.code === 'capture_required');
});
