import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

// Minimal deterministic DOM & MutationObserver harness for content.ts readiness unit tests.
class MockNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
}

class MockText extends MockNode {
  constructor(value, notify) {
    super(3);
    this._value = value;
    this._notify = notify;
  }
  get nodeValue() {
    return this._value;
  }
  set nodeValue(v) {
    this._value = v;
    this._notify?.([{ type: 'characterData', target: this, addedNodes: [], removedNodes: [] }]);
  }
  get textContent() {
    return this._value;
  }
}

function matchesSimpleSelector(el, single) {
  const s = single.trim();
  if (!s || el.nodeType !== 1) return false;
  if (s.startsWith('#')) return el.id === s.slice(1);
  if (s.startsWith('.')) return (el.className || '').split(/\s+/).includes(s.slice(1));
  const roleMatch = /^\[role=['"]([^'"]+)['"]\]$/.exec(s);
  if (roleMatch) return el.getAttribute('role') === roleMatch[1];
  const testIdMatch = /^\[data-testid=['"]([^'"]+)['"]\]$/.exec(s);
  if (testIdMatch) return el.getAttribute('data-testid') === testIdMatch[1];
  const attrNameMatch = /^([a-z0-9-]+)?\[([a-z0-9-]+)=['"]([^'"]+)['"]\]$/i.exec(s);
  if (attrNameMatch) {
    const [, tag, attr, val] = attrNameMatch;
    if (tag && el.localName !== tag.toLowerCase()) return false;
    return el.getAttribute(attr) === val;
  }
  return el.localName === s.toLowerCase();
}

function matchesSelectorList(el, selectorList) {
  return selectorList.split(',').some((part) => matchesSimpleSelector(el, part));
}

class MockElement extends MockNode {
  constructor(tag, notify) {
    super(1);
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.className = '';
    this.shadowRoot = null;
    this._attrs = new Map();
    this._rect = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    this._notify = notify;
  }
  setAttribute(name, value) {
    this._attrs.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }
  hasAttribute(name) {
    if (name === 'id') return Boolean(this.id);
    if (name === 'class') return Boolean(this.className);
    return this._attrs.has(name);
  }
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    this._notify?.([{ type: 'childList', target: this, addedNodes: [child], removedNodes: [] }]);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const idx = parent.childNodes.indexOf(this);
    if (idx >= 0) parent.childNodes.splice(idx, 1);
    this.parentNode = null;
    this._notify?.([{ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] }]);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent ?? '').join('');
  }
  set textContent(v) {
    const removed = [...this.childNodes];
    for (const r of removed) r.parentNode = null;
    this.childNodes = v ? [new MockText(String(v), this._notify)] : [];
    for (const c of this.childNodes) c.parentNode = this;
    this._notify?.([{ type: 'childList', target: this, addedNodes: [...this.childNodes], removedNodes: removed }]);
  }
  get innerText() {
    return this.textContent;
  }
  getBoundingClientRect() {
    return this._rect;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (matchesSelectorList(child, sel)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

function createDomEnv(readyState = 'interactive') {
  const activeObservers = new Set();
  const notify = (records) => {
    for (const obs of [...activeObservers]) {
      queueMicrotask(() => {
        if (activeObservers.has(obs)) obs._cb(records);
      });
    }
  };

  class MockMutationObserver {
    constructor(cb) {
      this._cb = cb;
    }
    observe() {
      activeObservers.add(this);
    }
    disconnect() {
      activeObservers.delete(this);
    }
  }

  const listeners = new Map();
  const documentElement = new MockElement('html', notify);
  const body = new MockElement('body', notify);
  documentElement.appendChild(body);
  // Clear initial setup notification by snapshotting activeObservers (empty right now)

  const doc = {
    readyState,
    title: 'Test Page',
    documentElement,
    body,
    createElement: (tag) => new MockElement(tag, notify),
    createTextNode: (txt) => new MockText(txt, notify),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    querySelector: (sel) => documentElement.querySelector(sel),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn);
    },
    emit(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };

  return { doc, body, documentElement, MockMutationObserver, activeObservers };
}

const contentBundle = await build({
  entryPoints: ['src/content/content.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const contentModuleUrl = `data:text/javascript;base64,${Buffer.from(contentBundle.outputFiles[0].text).toString('base64')}`;

const origGetEntriesByType = globalThis.performance.getEntriesByType.bind(globalThis.performance);

function installGlobals(env, navEntry) {
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  globalThis.document = env.doc;
  globalThis.MutationObserver = env.MockMutationObserver;
  globalThis.location = { href: 'https://www.reddit.com/r/rust/', hostname: 'www.reddit.com', origin: 'https://www.reddit.com', pathname: '/r/rust/', search: '', hash: '' };
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'MockBrowser/1.0' },
    configurable: true,
    writable: true,
  });
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  globalThis.window = globalThis;
  globalThis.performance.getEntriesByType = (type) =>
    type === 'navigation' ? (navEntry ? [navEntry] : []) : origGetEntriesByType(type);
}

const initialEnv = createDomEnv();
installGlobals(initialEnv, {
  startTime: 0,
  responseStart: 42,
  responseEnd: 118,
  domContentLoadedEventEnd: 165,
  loadEventEnd: 290,
  transferSize: 34816,
  nextHopProtocol: 'h3',
});
const contentMod = await import(contentModuleUrl);

test('waitForDomQuiet exits in ~0 ms when readinessSelector already matches and ignores script/overlay noise', async () => {
  const env = createDomEnv('interactive');
  installGlobals(env);

  const script = env.doc.createElement('script');
  script.textContent = 'window.__SSR_STATE__ = ' + JSON.stringify('x'.repeat(2000));
  env.body.appendChild(script);

  const overlay = env.doc.createElement('div');
  overlay.setAttribute('data-bb-overlay', 'handoff');
  overlay.textContent = 'Browser Bridge WAIT overlay text that must be ignored';
  env.body.appendChild(overlay);

  // Empty <main> containing ONLY an inline RSC/SSR <script> and min-h-screen box must NOT falsely satisfy selectorReady!
  const shellMain = env.doc.createElement('main');
  shellMain._rect = { width: 1280, height: 800, top: 0, left: 0, right: 1280, bottom: 800 };
  const rscScript = env.doc.createElement('script');
  rscScript.textContent = 'self.__next_f.push([1,"chunk"])';
  shellMain.appendChild(rscScript);
  env.body.appendChild(shellMain);
  assert.equal(contentMod.selectorReady('main'), false, 'script-only empty shell <main> must not count as ready');
  shellMain.remove();

  const main = env.doc.createElement('main');
  main.textContent = 'Rust 2026 release notes and subreddit discussion thread content.';
  env.body.appendChild(main);

  const t0 = Date.now();
  const res = await contentMod.waitForDomQuiet({
    maxWaitMs: 300,
    quietMs: 60,
    selector: 'shreddit-app, main',
  });
  const elapsed = Date.now() - t0;

  assert.equal(res.settled, true);
  assert.equal(res.waitedMs, 0);
  assert.equal(res.reason, 'selector');
  assert.ok(elapsed < 30, `Expected immediate exit (<30 ms), took ${elapsed} ms`);
  assert.equal(res.contentChars, 64);
  assert.equal(res.mainChars, 64);
  assert.equal(env.activeObservers.size, 0);
});

test('waitForDomQuiet resolves immediately on mutation as soon as readinessSelector mounts', async () => {
  const env = createDomEnv('interactive');
  installGlobals(env);

  setTimeout(() => {
    const grid = env.doc.createElement('ytd-rich-grid-renderer');
    grid.textContent = 'Polymer video results hydrated cleanly with full titles and metadata.';
    env.body.appendChild(grid);
  }, 25);

  const t0 = Date.now();
  const res = await contentMod.waitForDomQuiet({
    maxWaitMs: 400,
    quietMs: 150,
    selector: 'ytd-rich-grid-renderer, #contents',
  });
  const elapsed = Date.now() - t0;

  assert.equal(res.settled, true);
  assert.equal(res.reason, 'selector');
  assert.ok(elapsed < 120, `Expected early selector exit (<120 ms), took ${elapsed} ms`);
  assert.ok(res.contentChars >= 60);
  assert.equal(env.activeObservers.size, 0);
});

test('waitForDomQuiet exits after quiet window once mutations settle and ignores overlay mutations', async () => {
  const env = createDomEnv('interactive');
  installGlobals(env);

  const article = env.doc.createElement('article');
  article.textContent = 'Initial chunk ';
  env.body.appendChild(article);

  setTimeout(() => {
    const p = env.doc.createElement('p');
    p.textContent = 'Hydrated paragraph with enough characters to satisfy minChars easily across the article body.';
    article.appendChild(p);
  }, 20);

  // Overlay mutation at 45 ms must NOT reset the page quiet timer
  setTimeout(() => {
    const host = env.doc.createElement('div');
    host.id = '__bb_handoff_host__';
    host.textContent = 'Ignored host';
    env.body.appendChild(host);
  }, 45);

  const t0 = Date.now();
  const res = await contentMod.waitForDomQuiet({
    maxWaitMs: 500,
    quietMs: 45,
  });
  const elapsed = Date.now() - t0;

  assert.equal(res.settled, true);
  assert.equal(res.reason, 'quiet');
  assert.ok(res.waitedMs >= 45 && elapsed < 250, `Expected quiet exit around ~65-110 ms, got waitedMs=${res.waitedMs}, elapsed=${elapsed}`);
  assert.ok(res.contentChars >= 90);
  assert.ok(res.mainChars >= 90);
  assert.equal(env.activeObservers.size, 0);
});

test('waitForDomQuiet enforces hard maxWaitMs cap under continuous mutations without leaking observers', async () => {
  const env = createDomEnv('interactive');
  installGlobals(env);

  const feed = env.doc.createElement('div');
  env.body.appendChild(feed);
  const ticker = setInterval(() => {
    const item = env.doc.createElement('span');
    item.textContent = 'tick ';
    feed.appendChild(item);
  }, 12);

  try {
    const t0 = Date.now();
    const res = await contentMod.waitForDomQuiet({
      maxWaitMs: 90,
      quietMs: 50,
    });
    const elapsed = Date.now() - t0;

    assert.equal(res.settled, false);
    assert.equal(res.reason, 'cap');
    assert.ok(res.waitedMs <= 90);
    assert.ok(elapsed >= 75 && elapsed < 220, `Expected cap around 90 ms, took ${elapsed} ms`);
    assert.equal(env.activeObservers.size, 0);
  } finally {
    clearInterval(ticker);
  }
});

test('frameInfo exposes navigationTiming and detectChallengeMarkers exposes contentChars/mainChars', () => {
  const env = createDomEnv('complete');
  installGlobals(env, {
    startTime: 0,
    responseStart: 30,
    responseEnd: 95,
    domContentLoadedEventEnd: 140,
    loadEventEnd: 210,
    transferSize: 16384,
    nextHopProtocol: 'h2',
  });
  const main = env.doc.createElement('main');
  main.textContent = 'Primary article content.';
  env.body.appendChild(main);

  const info = globalThis.__bb.frameInfo();
  assert.deepEqual(info.navigationTiming, {
    ttfbMs: 30,
    networkMs: 95,
    domContentLoadedMs: 140,
    loadEventMs: 210,
    transferSize: 16384,
    protocol: 'h2',
  });

  const probe = contentMod.detectChallengeMarkers();
  assert.equal(probe.contentChars, 24);
  assert.equal(probe.mainChars, 24);
});

test('Commands navigate invokes waitForDomQuiet via callFrame (top-level Promise) and emits readiness & snapshot/text telemetry', async () => {
  const tabs = new Map();
  const localStore = new Map();
  const sessionStore = new Map();
  const makeEvent = () => {
    const set = new Set();
    return {
      addListener: (fn) => set.add(fn),
      removeListener: (fn) => set.delete(fn),
      emit: (...args) => { for (const fn of set) fn(...args); },
    };
  };

  const tabsUpdated = makeEvent();
  const navCommitted = makeEvent();
  const navDomLoaded = makeEvent();
  const headersReceived = makeEvent();
  const frameCalls = [];
  let failWaitForDomQuiet = false;
  let returnedTopLevelPromise = false;

  const env = createDomEnv('complete');
  installGlobals(env);
  const mainEl = env.doc.createElement('main');
  mainEl.textContent = 'Server-rendered Reddit thread content ready immediately on DOMContentLoaded.';
  env.body.appendChild(mainEl);

  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      onUpdated: tabsUpdated,
      onCreated: makeEvent(),
      query: async () => [...tabs.values()],
      get: async (id) => tabs.get(id),
      update: async (id, patch) => {
        const cur = tabs.get(id);
        const nextUrl = patch.url ?? cur.url;
        tabs.set(id, { ...cur, ...patch, url: nextUrl, status: 'complete' });
        if (patch.url) {
          queueMicrotask(() => {
            headersReceived.emit({ tabId: id, type: 'main_frame', url: nextUrl, requestId: 'r1', statusCode: 200 });
            navCommitted.emit({ tabId: id, frameId: 0, url: nextUrl });
            navDomLoaded.emit({ tabId: id, frameId: 0, url: nextUrl });
            tabsUpdated.emit(id, { status: 'complete' });
          });
        }
        return tabs.get(id);
      },
    },
    webNavigation: { onCommitted: navCommitted, onDOMContentLoaded: navDomLoaded, onErrorOccurred: makeEvent() },
    webRequest: { onHeadersReceived: headersReceived, onResponseStarted: makeEvent() },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, localStore.get(k)])),
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) localStore.set(k, v); },
      },
      session: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, sessionStore.get(k)])),
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v); },
      },
    },
    scripting: {
      executeScript: async (req) => {
        if (req.files) return [];
        const [method, args] = req.args;
        frameCalls.push({ method, args });
        if (method === 'waitForDomQuiet' && failWaitForDomQuiet) {
          throw new Error('Cannot access contents of page');
        }
        if (method === 'snapshot') {
          return [{
            frameId: 0,
            result: {
              ok: {
                text: '- main\n  - heading "Reddit Rust" [ref=e1]',
                truncated: false,
                omittedNodes: 0,
                visibleIframes: 0,
                url: 'https://www.reddit.com/r/rust/',
                title: 'r/rust',
                isTop: true,
                width: 1280,
                height: 800,
              },
            },
          }];
        }
        if (method === 'getText') {
          return [{
            frameId: 0,
            result: {
              ok: {
                text: 'Extracted clean full-page text body.',
                truncated: false,
                url: 'https://www.reddit.com/r/rust/',
                title: 'r/rust',
                isTop: true,
              },
            },
          }];
        }
        // Execute real invokeContent from page.ts against globalThis.__bb!
        const rawOut = req.func(...req.args);
        if (method === 'waitForDomQuiet') {
          returnedTopLevelPromise = Boolean(rawOut && typeof rawOut.then === 'function');
        }
        return [{ frameId: 0, result: await rawOut }];
      },
    },
  };

  try {
    const bgBundle = await build({
      stdin: {
        contents: "export { TabRegistry } from './src/background/tabs.ts'; export { Commands } from './src/background/commands.ts';",
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
    });
    const { TabRegistry, Commands } = await import(
      `data:text/javascript;base64,${Buffer.from(bgBundle.outputFiles[0].text).toString('base64')}`
    );

    const reg = new TabRegistry();
    reg.openSession('s1');
    tabs.set(7, { id: 7, title: 'r/rust', url: 'https://www.reddit.com/', status: 'complete' });
    reg.grant(7, 'user', null);
    const commands = new Commands(reg);

    // 1. Navigate with readinessSelector & hydrationSettleMs cap -> exits in 0ms via waitForDomQuiet
    frameCalls.length = 0;
    const navRes = await commands.run('s1', 'page.navigate', {
      tabId: 7,
      url: 'https://www.reddit.com/r/rust/',
      _noLearn: true,
      _siteProfile: {
        preferredWaitUntil: 'domcontentloaded',
        hydrationSettleMs: 150,
        readinessQuietMs: 60,
        readinessSelector: 'shreddit-app, main',
      },
    });
    assert.equal(returnedTopLevelPromise, true, 'invokeContent must return a top-level Promise for async content methods');
    const quietCall = frameCalls.find((c) => c.method === 'waitForDomQuiet');
    assert.ok(quietCall, 'navigate must call waitForDomQuiet when hydrationSettleMs > 0');
    assert.deepEqual(quietCall.args, [{ maxWaitMs: 150, quietMs: 60, selector: 'shreddit-app, main' }]);
    assert.equal(navRes._telemetry.settledMs, 0);
    assert.equal(navRes._telemetry.settleReason, 'selector');
    assert.equal(navRes._telemetry.contentChars, 76);
    assert.equal(navRes._telemetry.mainChars, 76);

    // 2. Navigate with hydrationSettleMs = 0 -> zero waitForDomQuiet round-trip, still reports contentChars via detectChallengeMarkers
    frameCalls.length = 0;
    const fastNavRes = await commands.run('s1', 'page.navigate', {
      tabId: 7,
      url: 'https://www.reddit.com/r/rust/new/',
      _siteProfile: { preferredWaitUntil: 'domcontentloaded' },
    });
    assert.equal(frameCalls.some((c) => c.method === 'waitForDomQuiet'), false);
    assert.equal(fastNavRes._telemetry.settledMs, 0);
    assert.equal(fastNavRes._telemetry.settleReason, 'already_ready');
    assert.equal(fastNavRes._telemetry.contentChars, 76);
    assert.equal(fastNavRes._telemetry.mainChars, 76);

    // 3. Navigate fallback sleep when waitForDomQuiet throws
    failWaitForDomQuiet = true;
    const fbNavRes = await commands.run('s1', 'page.navigate', {
      tabId: 7,
      url: 'https://www.reddit.com/r/rust/top/',
      _siteProfile: { preferredWaitUntil: 'domcontentloaded', hydrationSettleMs: 40 },
    });
    failWaitForDomQuiet = false;
    assert.equal(fbNavRes._telemetry.settledMs, 40);
    assert.equal(fbNavRes._telemetry.settleReason, 'fallback_sleep');

    // 4. Snapshot emits contentChars (excluding Tab/URL header) and truncated in _telemetry
    const snapRes = await commands.run('s1', 'page.snapshot', { tabId: 7 });
    const expectedSnapBody = '- main\n  - heading "Reddit Rust" [ref=e1]';
    assert.equal(snapRes._telemetry.contentChars, expectedSnapBody.length);
    assert.equal(snapRes._telemetry.truncated, false);

    // 5. getText (page.text) emits contentChars and truncated in _telemetry
    const textRes = await commands.run('s1', 'page.text', { tabId: 7 });
    assert.equal(textRes._telemetry.contentChars, 'Extracted clean full-page text body.'.length);
    assert.equal(textRes._telemetry.truncated, false);
  } finally {
    globalThis.chrome = prevChrome;
  }
});

test('all 24 seed routines/*.json files preserve schemaVersion 2, readinessSelector, and broadened google SERP locators', () => {
  const routinesDir = join(process.cwd(), '..', 'routines');
  const files = readdirSync(routinesDir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 24);

  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(routinesDir, file), 'utf8'));
    assert.equal(parsed.schemaVersion, 2, `${file} schemaVersion`);
    assert.ok(parsed.accessProfile?.readinessSelector, `${file} missing readinessSelector`);
  }

  const reddit = JSON.parse(readFileSync(join(routinesDir, 'reddit.com.json'), 'utf8'));
  assert.equal(reddit.accessProfile.hydrationSettleMs, 150);
  assert.equal(reddit.accessProfile.readinessQuietMs, 60);
  assert.match(reddit.accessProfile.readinessSelector, /shreddit-app/);

  const google = JSON.parse(readFileSync(join(routinesDir, 'google.com.json'), 'utf8'));
  for (const rName of ['search', 'read_results', 'next_results_page']) {
    const queryStep = google.routines[rName].steps.find((s) => s.op === 'query');
    assert.equal(
      queryStep.params.locator.steps[0].value,
      "#search, #rso, #rcnt, #center_col, [role='main'], main, body",
      `google.com ${rName} broadened locator`,
    );
  }
});
