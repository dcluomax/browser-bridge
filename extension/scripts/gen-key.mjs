// One-time generator for bridge.config.json. The Chromium manifest "key" pins the extension id for
// unpacked installs so the native messaging host can allow exactly that id. Only the public key is
// stored; an unpacked extension never needs the private key, so it is discarded.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumExtensionId } from '../build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'bridge.config.json');
if (existsSync(target) && !process.argv.includes('--force')) {
  console.error('bridge.config.json already exists; pass --force to rotate the extension id.');
  process.exit(1);
}
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
const chromiumPublicKey = Buffer.from(publicKey).toString('base64');
const config = {
  nativeHostName: 'io.github.dcluomax.browser_bridge',
  geckoId: 'browser-bridge@dcluomax.github.io',
  chromiumPublicKey,
  chromiumExtensionId: chromiumExtensionId(chromiumPublicKey),
};
writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${target} (chromium id ${config.chromiumExtensionId})`);
