// Builds the extension for Chromium (Edge/Chrome, Manifest V3) and Firefox (Manifest V2 with a
// persistent background page, which keeps the native messaging port alive without workarounds).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

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

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function collectFiles(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** Writes a deterministic, deflated PKZIP archive (.zip / .xpi) identically on Windows, macOS, and Linux. */
function writeZipArchive(sourceDir, outFile) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const files = collectFiles(sourceDir);
  for (const fullPath of files) {
    const relName = relative(sourceDir, fullPath).replaceAll('\\', '/');
    const nameBytes = Buffer.from(relName, 'utf8');
    const raw = readFileSync(fullPath);
    const compressed = deflateRawSync(raw, { level: 9 });
    const sum = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8);      // Deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(sum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(sum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outFile, Buffer.concat([...localParts, ...centralParts, eocd]));
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
    writeZipArchive(out, file);
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
