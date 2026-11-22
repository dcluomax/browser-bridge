import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { crc32, zipBytes } from '../scripts/archive.mjs';

test('XPI output is a real deterministic ZIP with correct CRC and central directory', () => {
  const files = [['manifest.json', '{"version":"0.13.0"}'], ['background.js', 'fixture']];
  const first = zipBytes(files, 315532800);
  const second = zipBytes([...files].reverse(), 315532800);
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  const end = first.length - 22;
  assert.equal(first.readUInt32LE(end), 0x06054b50);
  assert.equal(first.readUInt16LE(end + 10), 2);
  const central = first.readUInt32LE(end + 16);
  assert.equal(first.readUInt32LE(central), 0x02014b50);
  assert.equal(first.readUInt16LE(8), 0);
  assert.equal(first.readUInt16LE(12), 33);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('ZIP creation rejects traversal, case collisions, and invalid timestamps', () => {
  for (const path of ['../escape', '/escape', 'C:/escape', 'a\\escape', 'a//escape']) {
    assert.throws(() => zipBytes([[path, 'fixture']], 315532800), /Unsafe ZIP member/);
  }
  assert.throws(() => zipBytes([['a.js', 'a'], ['A.js', 'b']], 315532800), /Duplicate/);
  assert.throws(() => zipBytes([['manifest.json', '{}']], 'invalid'), /epoch seconds/);
});

test('Firefox signing fails explicitly before any network call when keys are absent', () => {
  const env = { ...process.env };
  for (const key of ['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET', 'AMO_JWT_ISSUER', 'AMO_JWT_SECRET']) delete env[key];
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/sign-firefox.mjs', import.meta.url))], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signing requires/);
  assert.match(result.stderr, /cannot permanently install an unsigned XPI/);
});
