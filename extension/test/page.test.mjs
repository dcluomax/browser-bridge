import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

let responses = [];
let injectionError;
const event = () => {
  const listeners = new Set();
  return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener), emit: (...args) => { for (const listener of listeners) listener(...args); } };
};
globalThis.chrome = {
  action: {},
  tabs: { onUpdated: event(), onCreated: event(), get: async () => ({ status: 'complete' }) },
  webNavigation: { onCommitted: event(), onDOMContentLoaded: event(), onErrorOccurred: event() },
  webRequest: { onHeadersReceived: event(), onResponseStarted: event() },
  scripting: {
    executeScript: async (request) => {
      if (injectionError) throw injectionError;
      return request.files ? [] : responses;
    },
  },
};
const bundle = await build({ entryPoints: ['src/background/page.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { callAllFrames, callFrame, watchNavigation } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const tab = { id: 1, url: 'https://example.test/' };

test('strict multi-frame reads reject partial errors instead of claiming absence', async () => {
  responses = [{ frameId: 0, result: { ok: false } }, { frameId: 3, result: { err: 'frame unavailable' } }];
  await assert.rejects(callAllFrames(tab, 'hasText', ['missing'], true), /Frame 3 could not be read/);
  assert.deepEqual(await callAllFrames(tab, 'hasText', ['missing']), [{ frameId: 0, result: false }]);
});

test('strict reads require a readable main frame', async () => {
  responses = [{ frameId: 3, result: { ok: false } }];
  await assert.rejects(callAllFrames(tab, 'hasText', ['missing'], true), /main frame could not be read/);
  responses = [];
  await assert.rejects(callAllFrames(tab, 'hasText', ['missing'], true), /main frame could not be read/);
});

test('strict reads preserve false results from successful frames', async () => {
  responses = [{ frameId: 3, result: { ok: false } }, { frameId: 0, result: { ok: false } }];
  assert.deepEqual(await callAllFrames(tab, 'hasText', ['missing'], true), [{ frameId: 0, result: false }, { frameId: 3, result: false }]);
});

test('single-frame missing or failed results stay errors', async () => {
  responses = [{ frameId: 0, result: { err: 'invalid selector' } }];
  await assert.rejects(callFrame(tab, 0, 'locate', []), /invalid selector/);
  responses = [];
  await assert.rejects(callFrame(tab, 0, 'locate', []), /did not return a result/);
});

test('permission failures are not swallowed by strict reads', async () => {
  injectionError = new Error('Cannot access contents of the page');
  try {
    await assert.rejects(callAllFrames(tab, 'hasText', ['missing'], true), /cannot be scripted/);
  } finally {
    injectionError = undefined;
  }
});

test('navigation ignores the replaced document abort and captures the final response', async () => {
  const watcher = watchNavigation(1, 'https://example.test/next');
  try {
    chrome.webNavigation.onErrorOccurred.emit({ tabId: 1, frameId: 0, url: 'about:blank', error: 'Error code 2152398850' });
    chrome.webRequest.onHeadersReceived.emit({ tabId: 1, type: 'main_frame', url: 'https://example.test/next', requestId: 'new', statusCode: 302 });
    chrome.webRequest.onHeadersReceived.emit({ tabId: 1, type: 'main_frame', url: 'https://example.test/final', requestId: 'new', statusCode: 200 });
    chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: 'https://example.test/final' });
    chrome.webNavigation.onDOMContentLoaded.emit({ tabId: 1, frameId: 0, url: 'https://example.test/final' });
    const result = await watcher.wait(0, 100, 'domcontentloaded');
    assert.equal(result.loaded, true);
    assert.equal(result.status, 200);
    assert.equal(result.error, undefined);
  } finally {
    watcher.dispose();
  }
});

test('an aborted navigation without a new commit cannot inherit old complete state', async () => {
  const watcher = watchNavigation(1, 'https://example.test/next');
  try {
    chrome.tabs.onUpdated.emit(1, { status: 'loading' });
    chrome.webNavigation.onErrorOccurred.emit({ tabId: 1, frameId: 0, url: 'https://example.test/next', error: 'Error code 2152398850' });
    const result = await watcher.wait(0, 10, 'load');
    assert.equal(result.loaded, false);
    assert.match(result.error, /2152398850/);
  } finally {
    watcher.dispose();
  }
});

test('response-started supplies status for a cached response with no header event', async () => {
  const watcher = watchNavigation(1, 'https://example.test/next');
  try {
    chrome.webRequest.onResponseStarted.emit({ tabId: 1, type: 'main_frame', url: 'https://example.test/next', requestId: 'cache', statusCode: 200 });
    chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: 'https://example.test/next' });
    chrome.webNavigation.onDOMContentLoaded.emit({ tabId: 1, frameId: 0, url: 'https://example.test/next' });
    assert.equal((await watcher.wait(0, 100, 'domcontentloaded')).status, 200);
  } finally {
    watcher.dispose();
  }
});

test('Firefox redirect document events may precede the final HTTP response', async () => {
  const watcher = watchNavigation(1, 'https://example.test/redirect');
  try {
    chrome.tabs.onUpdated.emit(1, { status: 'loading' });
    chrome.webRequest.onHeadersReceived.emit({ tabId: 1, type: 'main_frame', url: 'https://example.test/redirect', requestId: 'redirect', statusCode: 302 });
    chrome.webNavigation.onErrorOccurred.emit({ tabId: 1, frameId: 0, url: 'https://example.test/redirect', error: 'Error code 2152398850' });
    chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: 'https://example.test/final' });
    chrome.webNavigation.onDOMContentLoaded.emit({ tabId: 1, frameId: 0, url: 'https://example.test/final' });
    const waiting = watcher.wait(0, 1000, 'domcontentloaded');
    setTimeout(() => chrome.webRequest.onResponseStarted.emit({ tabId: 1, type: 'main_frame', url: 'https://example.test/final', requestId: 'redirect', statusCode: 200 }), 20);
    const result = await waiting;
    assert.equal(result.loaded, true);
    assert.equal(result.status, 200);
    assert.equal(result.error, undefined);
  } finally {
    watcher.dispose();
  }
});

test('DOMContentLoaded alone does not invent an HTTP response', async () => {
  const watcher = watchNavigation(1, 'https://example.test/next');
  try {
    chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: 'https://example.test/next' });
    chrome.webNavigation.onDOMContentLoaded.emit({ tabId: 1, frameId: 0, url: 'https://example.test/next' });
    const waiting = watcher.wait(0, 1000, 'domcontentloaded');
    setTimeout(() => chrome.webRequest.onHeadersReceived.emit({ tabId: 1, type: 'main_frame', url: 'https://example.test/next', requestId: 'late', statusCode: 404 }), 20);
    const result = await waiting;
    assert.equal(result.status, 404);
    assert.equal(result.loaded, true);
  } finally {
    watcher.dispose();
  }
});

test('navigation to a URL with a #fragment correlates with fragment-free HTTP response', async () => {
  const watcher = watchNavigation(1, 'https://app.diagrams.net/#');
  try {
    chrome.tabs.onUpdated.emit(1, { status: 'loading' });
    chrome.webRequest.onHeadersReceived.emit({ tabId: 1, type: 'main_frame', url: 'https://app.diagrams.net/', requestId: 'hash-nav', statusCode: 200 });
    chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: 'https://app.diagrams.net/#' });
    chrome.webNavigation.onDOMContentLoaded.emit({ tabId: 1, frameId: 0, url: 'https://app.diagrams.net/#' });
    chrome.tabs.onUpdated.emit(1, { status: 'complete' });
    const result = await watcher.wait(0, 100, 'load');
    assert.equal(result.loaded, true);
    assert.equal(result.status, 200);
    assert.equal(result.error, undefined);
  } finally {
    watcher.dispose();
  }
});

test('PWA service-worker navigation completes with status=null when no webRequest event fires', async () => {
  const watcher = watchNavigation(1, 'https://app.diagrams.net/#');
  try {
    chrome.tabs.onUpdated.emit(1, { status: 'loading' });
    chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: 'https://app.diagrams.net/#' });
    chrome.webNavigation.onDOMContentLoaded.emit({ tabId: 1, frameId: 0, url: 'https://app.diagrams.net/#' });
    chrome.tabs.onUpdated.emit(1, { status: 'complete' });
    const result = await watcher.wait(0, 1000, 'load');
    assert.equal(result.loaded, true);
    assert.equal(result.status, null);
    assert.equal(result.error, undefined);
  } finally {
    watcher.dispose();
  }
});

import './readiness.test.mjs';

