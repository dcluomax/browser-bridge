#!/usr/bin/env node
/**
 * Automated sanitization and secret-hygiene verifier for Browser Bridge.
 * Fails with exit code 1 if any personal path, corporate feed URL, legacy identifier,
 * credential token, or AI co-author trailer appears in tracked/workspace files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replaceAll('\\', '/');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'target',
  'build',
  '__pycache__',
  '.venv',
  'venv',
]);

const BINARY_EXTS = new Set(['.png', '.ico', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.zip', '.xpi', '.exe']);

// Build patterns dynamically so this script itself never triggers literal searches.
const RULES = [
  { id: 'personal-handle', re: new RegExp(['ma' + 'luo', 'max' + 'luo', 'dc' + 'luo(?!max)'].join('|'), 'i') },
  { id: 'corporate-email', re: new RegExp('max\\.luo@' + 'microsoft\\.com', 'i') },
  { id: 'corporate-npm-feed', re: /pkgs\.visualstudio\.com|packagefeedproxy\.microsoft\.io|pkgs\.dev\.azure\.com/i },
  { id: 'personal-onedrive-or-converter', re: /OneDrive[\\/]+Tools|musescore_to_pdf|WebsiteTools/i },
  { id: 'legacy-extension-id', re: /dmgaljkjepliflkkgpinpkemobomldlf/i },
  { id: 'live-instance-leak', re: /c4226b8c9535|5681b8ee1af5/i },
  { id: 'private-key-material', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { id: 'ai-coauthor-trailer', re: /Co-authored-by:\s*Copilot/i },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.endsWith('.egg-info')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, files);
    } else if (st.isFile() && !BINARY_EXTS.has(extname(entry).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

const findings = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  if (rel === SELF) continue;
  const content = readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        findings.push(`${rel}:${i + 1} [${rule.id}] ${line.trim().slice(0, 140)}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`Sanitization check failed (${findings.length} finding(s)):`);
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('Sanitization check passed: 0 personal, corporate, or secret leaks detected.');
