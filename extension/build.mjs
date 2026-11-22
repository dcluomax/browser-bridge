// Builds the extension for Chromium (Edge/Chrome, Manifest V3) and Firefox (Manifest V2 with a
// persistent background page, which keeps the native messaging port alive without workarounds).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZipFromDirectory } from './scripts/archive.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const loadConfig = () => JSON.parse(readFileSync(join(root, 'bridge.config.json'), 'utf8'));
const zip = process.argv.includes('--zip');

const NAME = '__MSG_extName__';
const DESCRIPTION = '__MSG_extDescription__';
const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };

export function chromiumManifest() {
  return {
    manifest_version: 3,
    default_locale: 'en',
    name: NAME,
    short_name: 'Browser Bridge',
    version: pkg.version,
    description: DESCRIPTION,
    key: loadConfig().chromiumPublicKey,
    minimum_chrome_version: '120',
    background: { service_worker: 'background.js' },
    action: { default_title: 'Browser Bridge', default_popup: 'popup.html', default_icon: icons },
    icons,
    permissions: ['nativeMessaging', 'tabs', 'tabGroups', 'scripting', 'storage', 'alarms', 'debugger', 'webNavigation', 'webRequest', 'contextMenus'],
    host_permissions: ['<all_urls>'],
    content_scripts: [
      {
        matches: ['http://*/*', 'https://*/*', 'file://*/*'],
        js: ['webmcp.js'],
        run_at: 'document_start',
        world: 'MAIN',
      },
    ],
  };
}

export function firefoxManifest() {
  return {
    manifest_version: 2,
    default_locale: 'en',
    name: NAME,
    version: pkg.version,
    description: DESCRIPTION,
    browser_specific_settings: {
      gecko: {
        id: loadConfig().geckoId,
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
    background: { scripts: ['background.js'], persistent: true },
    browser_action: { default_title: 'Browser Bridge', default_popup: 'popup.html', default_icon: icons },
    icons,
    permissions: ['nativeMessaging', 'tabs', 'scripting', 'storage', 'alarms', 'webNavigation', 'webRequest', 'contextMenus', '<all_urls>'],
  };
}

export function chromiumExtensionId(publicKeyBase64) {
  const digest = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...digest].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

async function buildTarget(target) {
  const out = join(root, 'dist', target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: {
      background: join(root, 'src/background/main.ts'),
      content: join(root, 'src/content/content.ts'),
      webmcp: join(root, 'src/content/webmcp.ts'),
      popup: join(root, 'src/popup/popup.tsx'),
    },
    outdir: out,
    bundle: true,
    minify: true,
    format: 'iife',
    target: target === 'firefox' ? ['firefox128'] : ['chrome120'],
    define: {
      __TARGET__: JSON.stringify(target),
      __EXT_VERSION__: JSON.stringify(pkg.version),
      'process.env.NODE_ENV': '"production"',
    },
    legalComments: 'none',
    logLevel: 'warning',
  });
  cpSync(join(root, 'src/popup/popup.html'), join(out, 'popup.html'));
  cpSync(join(root, 'static/icons'), join(out, 'icons'), { recursive: true });
  cpSync(join(root, 'static/_locales'), join(out, '_locales'), { recursive: true });
  const manifest = target === 'firefox' ? firefoxManifest() : chromiumManifest();
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (zip) {
    const artifacts = join(root, 'dist', 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    const file = join(artifacts, `browser-bridge-${target}-${pkg.version}.${target === 'firefox' ? 'xpi' : 'zip'}`);
    rmSync(file, { force: true });
    writeZipFromDirectory(out, file);
  }
  return out;
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const config = loadConfig();
  if (!existsSync(join(root, 'static/icons/icon-128.png'))) {
    console.error('Icons are missing; run: node scripts/make-icons.mjs');
    process.exit(1);
  }
  const id = chromiumExtensionId(config.chromiumPublicKey);
  if (id !== config.chromiumExtensionId) {
    console.error(`bridge.config.json chromiumExtensionId ${config.chromiumExtensionId} does not match key-derived id ${id}`);
    process.exit(1);
  }
  for (const target of ['chromium', 'firefox']) {
    const out = await buildTarget(target);
    console.log(`built ${target} -> ${out}`);
  }
  console.log(`Chromium extension id: ${id}; Firefox add-on id: ${config.geckoId}`);
}
