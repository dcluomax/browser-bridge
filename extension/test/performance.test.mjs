import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/content/performance.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { evidenceUrl, readPerformanceEvidence } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('performance evidence strips all URL credentials, query strings and fragments', () => {
  assert.equal(evidenceUrl('https://user:secret@example.test/path?code=private#token'), 'https://example.test/path');
  assert.equal(evidenceUrl('data:text/plain,private'), 'data:[omitted]');
  assert.equal(evidenceUrl('not a URL'), '[invalid URL omitted]');
});

test('point samples preserve unavailable timing instead of inventing load events', () => {
  const original = globalThis.performance;
  const entry = {
    name: 'https://cdn.test/file?private=yes', initiatorType: 'fetch', startTime: 20,
    duration: 7, responseStart: 0, responseEnd: 27, transferSize: 0, encodedBodySize: 0,
    nextHopProtocol: '',
  };
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: {
    timeOrigin: 1234,
    getEntriesByType: (type) => type === 'resource' ? [entry, entry] : [],
  } });
  try {
    const result = readPerformanceEvidence({ includeResources: true, maxEntries: 1 });
    assert.equal(result.navigation, null);
    assert.equal(result.source, 'browser-performance-api');
    assert.equal(result.totalResources, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.resources[0].durationMs, 7);
    assert.equal(result.resources[0].responseStartMs, null);
    assert.equal(result.resources[0].transferSize, null);
    assert.equal(result.resources[0].detailedTimingAvailable, false);
    assert.equal(result.resources[0].url, 'https://cdn.test/file');
    assert.equal(readPerformanceEvidence().resources.length, 0);
  } finally {
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: original });
  }
});

test('invalid performance budgets fail explicitly', () => {
  for (const maxEntries of [0, 201, 1.5, '2', NaN]) {
    assert.throws(() => readPerformanceEvidence({ maxEntries }), /integer from 1 to 200/);
  }
  assert.throws(() => readPerformanceEvidence({ includeResources: 'yes' }), /boolean/);
});
