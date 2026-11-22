import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const event = () => {
  const listeners = [];
  return { addListener: (listener) => listeners.push(listener), emit: (message) => listeners.forEach((listener) => listener(message)) };
};
const port = { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} };
globalThis.chrome = { runtime: { connectNative: () => port, getManifest: () => ({ version: '0.13.0' }) } };
const bundle = await build({ entryPoints: ['src/background/native.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { NativeConnection } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('native handshake surfaces minor-version drift without breaking basic connectivity', () => {
  const connection = new NativeConnection(() => {}, () => {}, async () => ({ type: 'hello' }));
  connection.connect();
  port.onMessage.emit({ type: 'hostHello', hostVersion: '0.12.0', protocol: 1, pipeName: 'test-pipe' });
  assert.equal(connection.connected, true);
  assert.ok(connection.versionWarning.includes('0.12.0'));
  port.onMessage.emit({ type: 'hostHello', hostVersion: '0.13.1', protocol: 1, pipeName: 'test-pipe' });
  assert.equal(connection.connected, true);
  assert.equal(connection.versionWarning, '');
});
