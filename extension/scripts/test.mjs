import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(root, 'test'))
  .filter((name) => /\.test\.(?:mjs|ts)$/.test(name))
  .sort()
  .map((name) => join(root, 'test', name));
if (files.length === 0) throw new Error('No extension tests were found.');
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
