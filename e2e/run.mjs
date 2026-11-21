// End-to-end test: launches a real browser with a throwaway profile and the unpacked extension,
// then drives it through the real MCP server (BrowserBridge.exe mcp) exactly like an AI client.
//
//   node e2e/run.mjs --browser edge|chromium|chrome|firefox [--headful] [--host <BrowserBridge.exe>]
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const browserName = option('browser', 'edge');
const headful = args.includes('--headful');
const hostExe = option('host', join(process.env.LOCALAPPDATA ?? '', 'BrowserBridge', 'app', 'BrowserBridge.exe'));

const BROWSERS = {
  edge: { kind: 'edge', exe: join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
  chrome: { kind: 'chrome', exe: join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe') },
  chromium: { kind: 'chromium', exe: findPlaywrightChromium() },
  firefox: { kind: 'firefox', exe: join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe') },
};

function findPlaywrightChromium() {
  const base = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!existsSync(base)) return '';
  const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const dir of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win', 'chrome-win-arm64']) {
      const exe = join(base, dir, sub, 'chrome.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listPipes() {
  try {
    return readdirSync('\\\\.\\pipe\\').filter((name) => name.startsWith('browser-bridge.'));
  } catch {
    return [];
  }
}

class McpClient {
  constructor(exe, env = process.env) {
    this.process = spawn(exe, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined && this.pending.has(message.id)) {
          this.pending.get(message.id)(message);
          this.pending.delete(message.id);
        }
      }
    });
    this.process.stderr.on('data', (chunk) => { this.stderr += chunk; });
  }

  request(method, params, timeoutMs = 90_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${this.stderr.slice(-500)}`)), timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const result = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-bridge-e2e', version: '1' } });
    this.notify('notifications/initialized', {});
    return result;
  }

  async call(name, argumentsObject = {}) {
    const result = await this.request('tools/call', { name, arguments: argumentsObject });
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { result, text, isError: Boolean(result.isError) };
  }

  close() {
    this.process.stdin.end();
    this.process.kill();
  }
}

const requestLog = [];

function serveFixtures() {
  const fixtures = join(repo, 'e2e', 'fixtures');
  const server = createServer((request, response) => {
    requestLog.push(`${new Date().toISOString().slice(11, 23)} ${request.headers.host} ${request.url}`);
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/binary') {
      const length = Math.min(20 * 1024 * 1024 + 1, Math.max(0, Number(url.searchParams.get('size')) || 0));
      response.writeHead(200, { 'content-type': 'application/octet-stream', ...(url.searchParams.has('chunked') ? {} : { 'content-length': length }) });
      response.end(Buffer.alloc(length, 0x61));
      return;
    }
    if (url.pathname === '/authenticated') {
      const authenticated = /bbfixture=session/.test(request.headers.cookie ?? '');
      response.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify({ authenticated }));
      return;
    }
    if (url.pathname === '/waf-protected') {
      const authenticated = /bbfixture=session/.test(request.headers.cookie ?? '');
      response.writeHead(authenticated ? 200 : 403, { 'content-type': 'application/json' }).end(JSON.stringify({ authenticated, source: authenticated ? 'browser_session' : 'blocked' }));
      return;
    }
    if (url.pathname === '/hang-beacon.gif') {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }).end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
      }, 4500);
      request.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/stalled-load.html') {
      const html = `<!doctype html><meta charset="utf-8"><title>Stalled Beacon Page</title>
        <h1 id="ready-title">Instant DOM Ready</h1>
        <div id="cookie-wall" style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:10">
          <button id="accept-cookies" onclick="this.parentElement.remove()">Accept Cookies</button>
        </div>
        <button id="buy-btn" onclick="this.textContent='Purchased'">Buy Now</button>
        <img src="/hang-beacon.gif?ts=${Date.now()}">`;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': 'bbfixture=session; HttpOnly; SameSite=Lax' }).end(html);
      return;
    }
    if (url.pathname === '/cloudflare-challenge.html') {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }).end(
        '<!doctype html><title>Just a moment...</title><div class="cf-turnstile">Verify you are human by Cloudflare</div>',
      );
      return;
    }
    if (url.pathname === '/diag-probe.html') {
      const sampleJwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJl'].join('.');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>Diag Probe</title>
        <input id="safe-note" placeholder="Note">
        <input id="secret-pw" type="password" placeholder="Password">
        <button id="fire-diag" onclick="
          console.error('Auth failed for Bearer ${sampleJwt}');
          fetch('/binary?size=16&api_key=sk-test-fixture-value-123', { headers: { Authorization: 'Bearer ${sampleJwt}' } });
          this.textContent = 'Fired';
        ">Run Probe</button>`);
      return;
    }
    if (url.pathname === '/video-post.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>Social Video Post</title>
        <article data-testid="tweet">
          <div data-testid="videoComponent">
            <video id="post-vid" poster="/thumb.jpg" muted></video>
          </div>
        </article>
        <script>
          const v = document.getElementById('post-vid');
          const b = new Blob(['stub'], { type: 'video/mp4' });
          v.src = URL.createObjectURL(b);
          fetch('/streams/master.m3u8?tag=16');
        </script>`);
      return;
    }
    if (url.pathname === '/streams/master.m3u8') {
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'access-control-allow-origin': `http://${request.headers.host}`,
      }).end([
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x492',
        '/streams/pl/320x492/low.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=468x720',
        '/streams/pl/468x720/high.m3u8',
      ].join('\n'));
      return;
    }
    if (url.pathname === '/streams/pl/468x720/high.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end([
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-MAP:URI="/streams/vid/avc1/0/0/468x720/init.mp4"',
        '#EXTINF:3.000,',
        '/streams/vid/avc1/0/3000/468x720/seg1.m4s',
        '#EXTINF:3.000,',
        '/streams/vid/avc1/3000/6000/468x720/seg2.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'));
      return;
    }
    if (url.pathname === '/streams/vid/avc1/0/0/468x720/init.mp4') {
      response.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2', 'binary'));
      return;
    }
    if (url.pathname === '/streams/vid/avc1/0/3000/468x720/seg1.m4s') {
      response.writeHead(200, { 'content-type': 'video/iso.segment' }).end(Buffer.from('\x00\x00\x00\x0cmoofSEG_ONE!', 'binary'));
      return;
    }
    if (url.pathname === '/streams/vid/avc1/3000/6000/468x720/seg2.m4s') {
      response.writeHead(200, { 'content-type': 'video/iso.segment' }).end(Buffer.from('\x00\x00\x00\x0cmoofSEG_TWO!', 'binary'));
      return;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: '/playwright.html' }).end();
      return;
    }
    if (url.pathname === '/not-found') {
      response.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Missing</title><p>Not found</p>');
      return;
    }
    if (url.pathname === '/fetch-csp.html') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'none'" }).end('<!doctype html><title>CSP fixture</title><p>Static page</p>');
      return;
    }
    const name = (request.url ?? '/').split('?')[0].replace(/^\//, '') || 'form.html';
    const file = join(fixtures, name);
    if (!/^[\w.-]+\.html$/.test(name) || !existsSync(file)) {
      response.writeHead(404).end('not found');
      return;
    }
    const html = readFileSync(file, 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'bbfixture=session; HttpOnly; SameSite=Lax' }).end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function launchBrowser(spec, profile) {
  const browserEnv = { ...process.env, BROWSER_BRIDGE_ROUTINES_DIR: join(profile, 'routines') };
  if (spec.kind === 'firefox') {
    const webExt = ['--yes', 'web-ext@10.8.0', 'run', '--source-dir', join(repo, 'extension', 'dist', 'firefox'), '--firefox', spec.exe,
      '--firefox-profile', profile, '--profile-create-if-missing', '--no-reload', '--no-input', '--start-url', 'about:blank'];
    if (!headful) webExt.push('--arg=-headless');
    // With shell: true on Windows, Node does not quote arguments; quote paths containing spaces.
    const quoted = process.platform === 'win32' ? webExt.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : webExt;
    return spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', quoted, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env: browserEnv });
  }
  const extension = join(repo, 'extension', 'dist', 'chromium');
  // --no-proxy-server: corporate PAC/WPAD discovery can stall the first requests of a fresh profile.
  const flags = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-proxy-server',
    '--enable-logging=stderr', '--v=0', '--remote-debugging-port=0',
    `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--window-size=1280,900', 'about:blank'];
  if (!headful) flags.unshift('--headless=new');
  return spawn(spec.exe, flags, { stdio: ['ignore', 'pipe', 'pipe'], env: browserEnv });
}

function killProfileProcesses(profile) {
  if (process.platform !== 'win32') return;
  const escaped = profile.replace(/'/g, "''");
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
}

/** Diagnostics for Chromium runs: lists DevTools targets so a missing extension service worker is visible. */
async function describeExtensionTargets(profile) {
  try {
    const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return `DevTools targets:\n${targets.map((t) => `  ${t.type} ${t.url}`).join('\n')}`;
  } catch (error) {
    return `DevTools targets unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? `\n      ${String(detail).slice(0, 600).replace(/\n/g, '\n      ')}` : ''}`);
  return Boolean(condition);
}

function refOf(snapshot, pattern) {
  const line = snapshot.split('\n').find((l) => pattern.test(l));
  return line ? /\[ref=([a-z0-9]+)\]/.exec(line)?.[1] : undefined;
}

async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(intervalMs);
  }
}

async function main() {
  const spec = BROWSERS[browserName];
  if (!spec || !spec.exe || !existsSync(spec.exe)) throw new Error(`Browser ${browserName} not found (${spec?.exe ?? 'unknown'}).`);
  if (!existsSync(hostExe)) throw new Error(`Host not installed at ${hostExe}; run scripts/install.ps1 first.`);

  const server = await serveFixtures();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`browser: ${spec.exe}\nfixtures: ${base}`);
  let profile = '';
  let browser;
  let launcherOutput = '';
  let pipe;
  // Chromium sometimes ignores --load-extension under x64 emulation; relaunch with a fresh profile.
  const attempts = spec.kind === 'firefox' ? 1 : 3;
  for (let attempt = 1; attempt <= attempts && !pipe; attempt++) {
    profile = mkdtempSync(join(tmpdir(), `bb-e2e-${browserName}-`));
    const before = new Set(listPipes());
    launcherOutput = '';
    browser = launchBrowser(spec, profile);
    browser.stdout?.on('data', (d) => { launcherOutput += d; });
    browser.stderr?.on('data', (d) => { launcherOutput += d; });
    const matchesBrowser = (p) => !before.has(p) && p.split('.')[2] === (spec.kind === 'chrome' ? 'chrome' : spec.kind);
    pipe = await waitFor(() => listPipes().find(matchesBrowser), spec.kind === 'firefox' ? 90_000 : 30_000, 500);
    if (!pipe && attempt < attempts) {
      console.log(`launch attempt ${attempt}: extension did not connect; ${await describeExtensionTargets(profile)}\nrelaunching with a fresh profile`);
      browser.kill();
      await sleep(1000);
      killProfileProcesses(profile);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {
        // ignore locked profile files
      }
    }
  }
  console.log(`profile: ${profile}`);
  const isolatedEnv = { ...process.env, BROWSER_BRIDGE_ROUTINES_DIR: join(profile, 'routines') };
  const client = new McpClient(hostExe, isolatedEnv);
  try {
    if (!pipe) console.log(await describeExtensionTargets(profile));
    if (!check('extension connected to native host (pipe appeared)', pipe, launcherOutput.slice(-1500))) return;
    const instance = pipe.split('.').pop();

    const init = await client.initialize();
    check('MCP initialize', init?.serverInfo?.name === 'browser-bridge', JSON.stringify(init));
    const tools = await client.request('tools/list', {});
    const names = tools.tools.map((t) => t.name);
    check('tools listed', ['browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_tabs'].every((n) => names.includes(n)), names.join(','));
    check('evaluate tool hidden by default', !names.includes('browser_evaluate'));
    check('locator tools are exposed without a code-string language', ['browser_locate', 'browser_get_element', 'browser_set_checked'].every((name) => names.includes(name)) && !names.includes('browser_run_playwright'), names.join(','));
    check('action schemas accept locators without requiring refs', ['browser_click', 'browser_type', 'browser_hover', 'browser_select_option', 'browser_press_key', 'browser_scroll'].every((name) => {
      const schema = tools.tools.find((tool) => tool.name === name)?.inputSchema;
      return schema?.properties?.locator && !schema.required?.includes('ref');
    }));

    const status = await client.call('browser_status', { browser: instance });
    check('browser_status selects the test browser', !status.isError && status.text.includes(`instance ${instance}`), status.text);

    const empty = await client.call('browser_tabs', { action: 'list' });
    check('no tabs are visible before sharing/opening', empty.text.includes('No tabs are available'), empty.text);

    const opened = await client.call('browser_tabs', { action: 'new', url: `${base}/form.html` });
    check('browser_tabs new opens the fixture', !opened.isError && opened.text.includes('Bridge Test'), opened.text);

    let snap = (await client.call('browser_snapshot')).text;
    const frameReady = await waitFor(async () => {
      if (/Frame button/.test(snap)) return true;
      snap = (await client.call('browser_snapshot')).text;
      return /Frame button/.test(snap);
    }, 30_000, 500);
    check('snapshot has heading and form controls', /heading "Bridge Test" \[level=1\]/.test(snap) && /textbox "Name"/.test(snap) && /button "Submit"/.test(snap), snap);
    check('snapshot masks password values', /textbox "Password".*\[password\]/.test(snap) && !snap.includes('secret-value'), snap);
    check('snapshot omits display:none text', !snap.includes('Invisible secret text'), snap);
    check('snapshot includes shadow DOM', /button "Shadow action" \[ref=e\d+\]/.test(snap), snap);
    check('snapshot includes cross-origin iframe with frame refs', frameReady && /button "Frame button" \[ref=f\d+e\d+\]/.test(snap), snap);
    check('snapshot marks cursor:pointer elements', /generic "Clickable card" \[cursor=pointer\] \[ref=e\d+\]/.test(snap), snap);

    const nameRef = refOf(snap, /textbox "Name"/);
    const typed = await client.call('browser_type', { ref: nameRef, text: 'Ada Lovelace' });
    check('browser_type sets the value', !typed.isError && typed.text.includes('"Ada Lovelace"'), typed.text);

    const subRef = refOf(snap, /checkbox "Subscribe"/);
    const clickedSub = await client.call('browser_click', { ref: subRef });
    check('browser_click on checkbox', !clickedSub.isError, clickedSub.text);

    const colorRef = refOf(snap, /combobox "Color"/);
    const selected = await client.call('browser_select_option', { ref: colorRef, values: ['Green'] });
    check('browser_select_option', !selected.isError && selected.text.includes('Green'), selected.text);

    const submitRef = refOf(snap, /button "Submit"/);
    await client.call('browser_click', { ref: submitRef });
    const submitted = await client.call('browser_wait_for', { text: 'Submitted: Ada Lovelace / subscribed / green', timeoutSeconds: 10 });
    check('form submitted with typed, checked and selected values', !submitted.isError, submitted.text);

    const after = (await client.call('browser_snapshot')).text;
    check('snapshot reflects checked state and value', /checkbox "Subscribe" \[checked\]/.test(after) && /textbox "Name".*: "Ada Lovelace"/.test(after), after);

    const shadow = await client.call('browser_click', { ref: refOf(snap, /button "Shadow action"/) });
    const shadowDone = await client.call('browser_wait_for', { text: 'Shadow clicked', timeoutSeconds: 5 });
    check('click inside shadow DOM', !shadow.isError && !shadowDone.isError, `${shadow.text}\n${shadowDone.text}`);

    const frameRef = refOf(snap, /button "Frame button"/);
    const frameClick = await client.call('browser_click', { ref: frameRef });
    const frameDone = await client.call('browser_wait_for', { text: 'Frame clicked', timeoutSeconds: 5 });
    check('click inside cross-origin iframe', !frameClick.isError && !frameDone.isError, `${frameClick.text}\n${frameDone.text}`);

    const card = await client.call('browser_click', { ref: refOf(snap, /Clickable card/) });
    const cardDone = await client.call('browser_wait_for', { text: 'Card clicked', timeoutSeconds: 5 });
    check('click on cursor:pointer element', !card.isError && !cardDone.isError, `${card.text}\n${cardDone.text}`);

    const notesRef = refOf(snap, /textbox "Notes"/);
    const notes = await client.call('browser_type', { ref: notesRef, text: 'Hello notes' });
    const notesText = await client.call('browser_get_text');
    check('type into contenteditable', !notes.isError && notesText.text.includes('Hello notes'), `${notes.text}\n${notesText.text.slice(0, 400)}`);

    const valInput = await client.call('browser_get_element', { ref: nameRef, operation: 'value' });
    const valEditable = await client.call('browser_get_element', { ref: notesRef, operation: 'value' });
    check(
      'browser_get_element accepts operation="value" on input and contenteditable',
      !valInput.isError && valInput.text.includes('Ada Lovelace') && !valEditable.isError && valEditable.text.includes('Hello notes'),
      `${valInput.text}\n${valEditable.text}`,
    );

    const pressed = await client.call('browser_press_key', { key: 'ArrowUp', ref: refOf(snap, /button "Load later"/) });
    const keyDone = await client.call('browser_wait_for', { text: 'key: ArrowUp', timeoutSeconds: 5 });
    check('browser_press_key reaches page listeners', !pressed.isError && !keyDone.isError, `${pressed.text}\n${keyDone.text}`);

    await client.call('browser_click', { ref: refOf(snap, /button "Load later"/) });
    const delayed = await client.call('browser_wait_for', { text: 'Loaded after delay', timeoutSeconds: 10 });
    check('browser_wait_for waits for delayed text', !delayed.isError, delayed.text);

    const shot = await client.call('browser_screenshot');
    const image = shot.result.content?.find((c) => c.type === 'image');
    const bytes = image ? Buffer.from(image.data, 'base64') : Buffer.alloc(0);
    check('browser_screenshot returns a JPEG image', bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.length > 1000, shot.text);

    const savedPngPath = join(profile, 'mcp-saved-shot.png');
    const savedShot = await client.call('browser_screenshot', { path: savedPngPath, ref: nameRef });
    const savedHasNoInlineImage = !savedShot.result.content?.some((c) => c.type === 'image');
    const savedBytes = existsSync(savedPngPath) ? readFileSync(savedPngPath) : Buffer.alloc(0);
    check('browser_screenshot saves element PNG directly to path', !savedShot.isError && savedHasNoInlineImage && savedBytes[0] === 0x89 && savedBytes[1] === 0x50, savedShot.text);

    const resourcesList = await client.request('resources/list', {});
    const guideRes = await client.request('resources/read', { uri: 'bridge://guide' });
    check(
      'MCP exposes resources/list and reads bridge://guide',
      Array.isArray(resourcesList?.resources) &&
        resourcesList.resources.some((r) => r.uri === 'bridge://guide') &&
        guideRes?.contents?.[0]?.text?.includes('Browser Bridge'),
      JSON.stringify(resourcesList),
    );

    const promptsList = await client.request('prompts/list', {});
    check(
      'MCP exposes prompts/list',
      Array.isArray(promptsList?.prompts) && promptsList.prompts.some((p) => p.name === 'inspect-shared-tab'),
      JSON.stringify(promptsList),
    );

    const routinesCatalog = await client.call('browser_routine_list', { domain: 'app.diagrams.net', includeTrace: false });
    check(
      'MCP exposes built-in diagrams.net Site Memory routines',
      !routinesCatalog.isError &&
        routinesCatalog.text.includes('read_diagram_xml') &&
        routinesCatalog.text.includes('write_diagram_xml'),
      routinesCatalog.text,
    );

    const nav = await client.call('browser_click', { ref: refOf(snap, /link "Next page"/) });
    check('link click navigates', !nav.isError && nav.text.includes('Second page'), nav.text);
    const stale = await client.call('browser_click', { ref: submitRef });
    check('stale refs are rejected after navigation', stale.isError && /stale|unknown/i.test(stale.text), stale.text);

    const back = await client.call('browser_history', { action: 'back' });
    check('browser_history back', !back.isError && back.text.includes('/form.html'), back.text);

    const batchRes = await client.call('browser_batch', {
      variables: { batchUser: 'Margaret Hamilton' },
      steps: [
        { op: 'type', params: { locator: { steps: [{ kind: 'label', value: 'Name' }] }, text: '{{batchUser}}', clear: true } },
        { op: 'query', params: { operation: 'value', locator: { steps: [{ kind: 'label', value: 'Name' }] } }, saveAs: 'batchVal' },
      ],
    });
    check(
      'browser_batch executes multi-step sequence in one MCP call',
      !batchRes.isError && batchRes.text.includes('Margaret Hamilton'),
      batchRes.text,
    );

    const navigated = await client.call('browser_navigate', { url: `${base}/second.html` });
    check('browser_navigate', !navigated.isError && navigated.text.includes('Second page'), navigated.text);

    const pythonArgs = [join(repo, 'e2e', 'python_api.py'), '--base', base, '--browser', instance, '--host', hostExe];
    const python = spawn(process.platform === 'win32' ? 'python' : 'python3', pythonArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...isolatedEnv, PYTHONPATH: [join(repo, 'python'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
    });
    let pythonOutput = '';
    python.stdout.on('data', (data) => { pythonOutput += data; });
    python.stderr.on('data', (data) => { pythonOutput += data; });
    const pythonExit = await new Promise((resolve, reject) => {
      python.on('error', reject);
      python.on('exit', resolve);
    });
    console.log(pythonOutput.trim());
    check('managed Python SDK integration suite', pythonExit === 0, pythonOutput);

    const listed = await client.call('browser_tabs', { action: 'list' });
    const tabLines = listed.text.split('\n').filter((l) => l.startsWith('- ['));
    check('only the agent tab is listed', tabLines.length === 1 && listed.text.includes('(current)'), listed.text);

    const denied = await client.call('browser_tabs', { action: 'select', tabId: 999999 });
    check('unknown or unshared tabs are refused', denied.isError, denied.text);

    const evalDenied = await client.request('tools/call', { name: 'browser_evaluate', arguments: { expression: '1+1' } }).then((r) => r.isError === true, () => true);
    check('browser_evaluate is unavailable without --allow-evaluate', evalDenied);

    const closed = await client.call('browser_tabs', { action: 'close' });
    check('browser_tabs close', !closed.isError, closed.text);
  } finally {
    client.close();
    browser.kill();
    await sleep(1500);
    killProfileProcesses(profile);
    server.close();
    await sleep(1000);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      // profile files may still be locked briefly
    }
  }
}

try {
  await main();
} catch (error) {
  check('e2e run completed', false, error instanceof Error ? error.stack : String(error));
}
const failed = results.filter((r) => !r.ok);
if (failed.length) console.log(`\nfixture requests:\n  ${requestLog.join('\n  ') || '(none)'}`);
console.log(`\n${browserName}: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
