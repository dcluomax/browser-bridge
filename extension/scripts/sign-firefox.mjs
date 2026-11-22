import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const key = process.env.WEB_EXT_API_KEY || process.env.AMO_JWT_ISSUER;
const secret = process.env.WEB_EXT_API_SECRET || process.env.AMO_JWT_SECRET;
if (!key || !secret) {
  console.error('Firefox signing requires WEB_EXT_API_KEY/WEB_EXT_API_SECRET or AMO_JWT_ISSUER/AMO_JWT_SECRET.');
  console.error('Release Firefox cannot permanently install an unsigned XPI. Use temporary development activation instead.');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(root, 'bridge.config.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'dist', 'firefox', 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version || manifest.browser_specific_settings?.gecko?.id !== config.geckoId) {
  throw new Error('Build the matching Firefox extension before signing.');
}
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!existsSync(npmCli)) throw new Error('Install npm beside Node, or invoke this guarded helper from an npm script.');
const result = spawnSync(process.execPath, [
  npmCli, 'exec', '--yes', '--package=web-ext@10.8.0', '--', 'web-ext', 'sign',
  '--source-dir', join(root, 'dist', 'firefox'), '--channel', 'unlisted',
  '--artifacts-dir', join(root, 'dist', 'signed'),
], {
  cwd: root,
  env: { ...process.env, WEB_EXT_API_KEY: key, WEB_EXT_API_SECRET: secret },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
