import { api, isChromium } from '../shared/api.ts';
import { BridgeError } from '../shared/protocol.ts';
import type { ContentApi } from '../content/content.ts';
import * as cdp from './cdp.ts';

export type ContentMethod = keyof ContentApi & string;

export interface FrameResult<T> {
  frameId: number;
  result: T;
}

const RESTRICTED = /^(chrome|edge|brave|opera|vivaldi|about|view-source|chrome-extension|moz-extension|devtools|chrome-search|chrome-untrusted|resource|jar):/i;
const STORE_HOSTS = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons|addons\.mozilla\.org)/i;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isBlank(url: string | undefined): boolean {
  return !url || url === 'about:blank' || url === 'about:newtab' || url === 'about:home';
}

/** Current URL of a tab; `url` is an empty string (not undefined) while the first navigation is pending. */
export function tabUrl(tab: chrome.tabs.Tab): string {
  return tab.url || tab.pendingUrl || '';
}

export function assertScriptable(tab: chrome.tabs.Tab): void {
  const url = tabUrl(tab);
  if (isBlank(url)) return;
  if (RESTRICTED.test(url) || STORE_HOSTS.test(url)) {
    throw new BridgeError('restricted', `The browser does not allow extensions to read or control ${url.split('?')[0]}. Navigate to a regular web page first.`);
  }
}

function describeInjectionError(error: unknown, tab: chrome.tabs.Tab): BridgeError {
  const message = error instanceof Error ? error.message : String(error);
  if (isNotReady(message)) {
    return new BridgeError('not_ready', `The page is still loading (${message}). Wait a moment, e.g. with browser_wait_for, and retry.`);
  }
  if (/error page/i.test(message)) {
    return new BridgeError('error_page', `The tab shows a browser error page; the site could not be loaded (${tabUrl(tab)}).`);
  }
  if (/cannot access|cannot be scripted|missing host permission|extensions gallery|is not allowed/i.test(message)) {
    return new BridgeError('restricted', `The page ${tab.url ?? ''} cannot be scripted by extensions (${message}).`);
  }
  if (/no tab with id|frame with id \d+ was removed|was removed|no frame/i.test(message)) {
    return new BridgeError('no_tab', `The tab or frame is gone (${message}).`);
  }
  return new BridgeError('script_error', message);
}

function isNotReady(message: string): boolean {
  return /not ready/i.test(message);
}

/** Retries injection briefly while a navigation is committing; other errors are reported immediately. */
async function executeWithRetry<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNotReady(message) || Date.now() > deadline) throw error;
      await sleep(250);
    }
  }
}

const EXPECTED_CONTENT_VERSION = '0.13.0';

interface ContentOutcome {
  ok?: unknown;
  err?: string;
  code?: string;
  missing?: boolean;
}

/** Runs inside the page (isolated world). Must be self-contained: it is serialized by the browser. */
function invokeContent(
  method: string,
  args: unknown[],
  expectedVersion: string,
): ContentOutcome | Promise<ContentOutcome> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bb = (globalThis as any).__bb;
  const isOlder = (actual: string, expected: string): boolean => {
    const a = actual.split('.').map((n) => parseInt(n, 10) || 0);
    const b = expected.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
    }
    return false;
  };
  if (
    !bb ||
    (typeof bb.version === 'string' && isOlder(bb.version, expectedVersion)) ||
    typeof bb[method] !== 'function'
  ) {
    return { missing: true };
  }
  const failure = (error: unknown): ContentOutcome => ({
    err: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
  });
  try {
    const out = bb[method](...args);
    if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
      return Promise.resolve(out).then(
        (ok) => ({ ok }),
        failure,
      );
    }
    return { ok: out };
  } catch (error) {
    return failure(error);
  }
}

async function inject(target: chrome.scripting.InjectionTarget, tab: chrome.tabs.Tab): Promise<void> {
  try {
    await executeWithRetry(() =>
      api.scripting.executeScript({
        target,
        files: ['content.js'],
        ...(isChromium ? { injectImmediately: true } : {}),
      }),
    );
  } catch (error) {
    throw describeInjectionError(error, tab);
  }
}

/** Calls a content API method in one frame and returns its result, injecting content.js lazily only on first use per document. */
export async function callFrame<T>(tab: chrome.tabs.Tab, frameId: number, method: ContentMethod, args: unknown[] = []): Promise<T> {
  assertScriptable(tab);
  const target: chrome.scripting.InjectionTarget = { tabId: tab.id!, frameIds: [frameId] };
  const immediate = isChromium ? { injectImmediately: true } : {};
  let results: chrome.scripting.InjectionResult<ContentOutcome>[];
  try {
    results = (await executeWithRetry(() =>
      api.scripting.executeScript({ target, func: invokeContent, args: [method, args, EXPECTED_CONTENT_VERSION], ...immediate }),
    )) as chrome.scripting.InjectionResult<ContentOutcome>[];
  } catch (error) {
    throw describeInjectionError(error, tab);
  }
  let value = results?.[0]?.result;
  if (value?.missing) {
    await inject(target, tab);
    try {
      results = (await executeWithRetry(() =>
        api.scripting.executeScript({ target, func: invokeContent, args: [method, args, EXPECTED_CONTENT_VERSION], ...immediate }),
      )) as chrome.scripting.InjectionResult<ContentOutcome>[];
    } catch (error) {
      throw describeInjectionError(error, tab);
    }
    value = results?.[0]?.result;
  }
  if (!value || value.missing) throw new BridgeError('script_error', `Frame ${frameId} did not return a result for ${method}.`);
  if (value.err !== undefined) throw new BridgeError(value.code ?? 'page_error', value.err);
  return value.ok as T;
}

/** Calls every accessible frame. Strict reads must not mistake a failed frame for absent content. */
export async function callAllFrames<T>(tab: chrome.tabs.Tab, method: ContentMethod, args: unknown[] = [], strict = false): Promise<Array<FrameResult<T>>> {
  assertScriptable(tab);
  const target: chrome.scripting.InjectionTarget = { tabId: tab.id!, allFrames: true };
  const immediate = isChromium ? { injectImmediately: true } : {};
  await inject(target, tab);
  let results: chrome.scripting.InjectionResult<{ ok?: unknown; err?: string; missing?: boolean }>[];
  try {
    results = (await executeWithRetry(() =>
      api.scripting.executeScript({ target, func: invokeContent, args: [method, args, EXPECTED_CONTENT_VERSION], ...immediate }),
    )) as chrome.scripting.InjectionResult<{ ok?: unknown; err?: string; missing?: boolean }>[];
  } catch (error) {
    throw describeInjectionError(error, tab);
  }
  const frames: Array<FrameResult<T>> = [];
  for (const entry of results ?? []) {
    if (entry?.result && !entry.result.missing && entry.result.err === undefined && entry.result.ok !== undefined) {
      frames.push({ frameId: entry.frameId ?? 0, result: entry.result.ok as T });
    } else if (strict) {
      throw new BridgeError('script_error', `Frame ${entry?.frameId ?? 'unknown'} could not be read: ${entry?.result?.err ?? 'no content result'}.`);
    } else if (entry?.frameId === 0 && entry.result?.err) {
      throw new BridgeError('page_error', entry.result.err);
    }
  }
  if (strict && !frames.some((frame) => frame.frameId === 0)) throw new BridgeError('script_error', 'The main frame could not be read.');
  frames.sort((a, b) => a.frameId - b.frameId);
  return frames;
}

export interface NavigationOutcome {
  navigated: boolean;
  loaded: boolean;
  domLoaded?: boolean;
  domLoadedMs?: number;
  loadMs?: number;
  swNoHeaders?: boolean;
  status: number | null;
  error?: string;
}

export interface NavigationWatch {
  wait(
    startTimeoutMs: number,
    loadTimeoutMs: number,
    waitUntil?: 'load' | 'domcontentloaded' | 'commit',
    swGraceMs?: number,
  ): Promise<NavigationOutcome>;
  openedTabs(): number[];
  events(): Array<Record<string, unknown>>;
  dispose(): void;
}

type ResponseDetails = { tabId: number; type: string; url: string; requestId: string; statusCode: number };
interface NavigationObserver {
  onUpdated(id: number, info: { status?: string }): void;
  onCreated(tab: chrome.tabs.Tab): void;
  onCommitted(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void;
  onDomLoaded(details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void;
  onError(details: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails): void;
  onResponse(details: ResponseDetails): undefined;
}

const navigationObservers = new Map<number, Set<NavigationObserver>>();
// Network and document events can arrive out of order. Keep observers active before navigation.
api.tabs.onUpdated.addListener((id, info) => { for (const observer of navigationObservers.get(id) ?? []) observer.onUpdated(id, info); });
api.tabs.onCreated.addListener((tab) => { for (const observer of navigationObservers.get(tab.openerTabId ?? -1) ?? []) observer.onCreated(tab); });
api.webNavigation.onCommitted.addListener((details) => { for (const observer of navigationObservers.get(details.tabId) ?? []) observer.onCommitted(details); });
api.webNavigation.onDOMContentLoaded.addListener((details) => { for (const observer of navigationObservers.get(details.tabId) ?? []) observer.onDomLoaded(details); });
api.webNavigation.onErrorOccurred.addListener((details) => { for (const observer of navigationObservers.get(details.tabId) ?? []) observer.onError(details); });
const observeResponse = (details: ResponseDetails): undefined => {
  for (const observer of navigationObservers.get(details.tabId) ?? []) observer.onResponse(details);
  return undefined;
};
api.webRequest.onHeadersReceived.addListener(observeResponse, { urls: ['<all_urls>'], types: ['main_frame'] });
api.webRequest.onResponseStarted.addListener(observeResponse, { urls: ['<all_urls>'], types: ['main_frame'] });

function stripHash(url: string | undefined): string | undefined {
  return url === undefined ? undefined : url.split('#')[0];
}

/** Observes a tab for a navigation (and for popups it opens) started by an action. */
export function watchNavigation(tabId: number, expectedUrl?: string, trace = false): NavigationWatch {
  let sawLoading = false;
  let complete = false;
  let domLoaded = false;
  let committed = false;
  let status: number | null = null;
  let navigationError: string | undefined;
  let aborted: string | undefined;
  let currentUrl = expectedUrl;
  const expectedBase = stripHash(expectedUrl);
  let requestId: string | undefined;
  let responseUrl: string | undefined;
  let pendingCommit: string | undefined;
  let pendingDom: string | undefined;
  const events: Array<Record<string, unknown>> = [];
  const record = (event: string, details: object) => { if (trace && events.length < 50) events.push({ event, ...details }); };
  const opened: number[] = [];
  const acceptCommit = (url: string) => {
    sawLoading = true;
    committed = true;
    currentUrl = url;
    domLoaded = pendingDom !== undefined && stripHash(pendingDom) === stripHash(url);
    navigationError = undefined;
    aborted = undefined;
  };
  const onUpdated = (id: number, info: { status?: string }) => {
    if (id !== tabId) return;
    record('tab', info);
    if (info.status === 'loading') {
      sawLoading = true;
      complete = false;
    } else if (info.status === 'complete' && sawLoading && (!expectedUrl || committed)) {
      complete = true;
    }
  };
  const onCommitted = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    record('committed', { url: details.url });
    pendingCommit = details.url;
    if (expectedBase && stripHash(details.url) !== expectedBase && stripHash(details.url) !== stripHash(responseUrl)) return;
    acceptCommit(details.url);
  };
  const onDomLoaded = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    record('domcontentloaded', { url: details.url });
    pendingDom = details.url;
    if (expectedUrl && stripHash(details.url) !== stripHash(currentUrl)) return;
    sawLoading = true;
    committed = true;
    domLoaded = true;
  };
  const onResponse = (details: ResponseDetails): undefined => {
    if (details.tabId === tabId) record('response', { url: details.url, requestId: details.requestId, statusCode: details.statusCode });
    if (details.tabId === tabId && details.type === 'main_frame') {
      const followUpChain =
        requestId === undefined
          ? !expectedBase || stripHash(details.url) === expectedBase || sawLoading
          : details.requestId === requestId ||
            (status !== null && status >= 300 && status < 400) ||
            aborted !== undefined ||
            sawLoading;
      if (followUpChain) {
        requestId = details.requestId;
        responseUrl = details.url;
        status = details.statusCode;
        if (pendingCommit && stripHash(pendingCommit) === stripHash(details.url)) acceptCommit(pendingCommit);
      }
    }
    return undefined;
  };
  const onError = (details: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
    if (details.tabId === tabId && details.frameId === 0) record('error', { url: details.url, error: details.error });
    if (details.tabId !== tabId || details.frameId !== 0 || (currentUrl && stripHash(details.url) !== stripHash(currentUrl))) return;
    if (/ERR_ABORTED|NS_BINDING_ABORTED|2152398850/.test(details.error)) aborted = details.error;
    else navigationError = details.error;
  };
  const onCreated = (tab: chrome.tabs.Tab) => {
    if (tab.openerTabId === tabId && tab.id !== undefined) opened.push(tab.id);
  };
  const observer: NavigationObserver = { onUpdated, onCreated, onCommitted, onDomLoaded, onError, onResponse };
  const observers = navigationObservers.get(tabId) ?? new Set<NavigationObserver>();
  observers.add(observer);
  navigationObservers.set(tabId, observers);
  return {
    async wait(startTimeoutMs, loadTimeoutMs, waitUntil = 'load', swGraceMs = 200) {
      const start = Date.now();
      const deadline = start + loadTimeoutMs;
      let domLoadedAt = 0;
      let completeAt = 0;
      while (!sawLoading && !navigationError && Date.now() - start < Math.min(startTimeoutMs, loadTimeoutMs)) {
        await sleep(30);
        if (!sawLoading) {
          const tab = await api.tabs.get(tabId).catch(() => undefined);
          if (!tab) return { navigated: false, loaded: false, status };
          if (tab.status === 'loading') sawLoading = true;
        }
      }
      if (!sawLoading) return { navigated: false, loaded: !navigationError && !aborted && !expectedUrl, status, error: navigationError ?? aborted };
      let docReadyAt = 0;
      let usedSwGrace = false;
      const isResponseReady = () => {
        const swGraceElapsed = docReadyAt > 0 && requestId === undefined && Date.now() - docReadyAt >= swGraceMs;
        if (swGraceElapsed) usedSwGrace = true;
        return (
          !expectedUrl ||
          !/^https?:/i.test(expectedUrl) ||
          (status !== null && stripHash(responseUrl) === stripHash(currentUrl)) ||
          swGraceElapsed
        );
      };
      const reached = () => {
        if ((domLoaded || complete) && domLoadedAt === 0) domLoadedAt = Math.max(1, Date.now() - start);
        if (complete && completeAt === 0) completeAt = Math.max(1, Date.now() - start);
        const documentReady = complete || (waitUntil === 'domcontentloaded' && domLoaded) || (waitUntil === 'commit' && committed);
        if ((documentReady || domLoaded) && committed && docReadyAt === 0) docReadyAt = Date.now();
        return documentReady && isResponseReady();
      };
      while (!reached() && !navigationError && Date.now() < deadline) {
        await sleep(50);
        const tab = await api.tabs.get(tabId).catch(() => undefined);
        if (!tab) break;
        if (tab.status === 'complete' && (!expectedUrl || committed)) complete = true;
      }
      const finalReached = reached();
      const domUsable = (domLoaded || complete) && committed && isResponseReady() && !navigationError && !aborted;
      return {
        navigated: true,
        loaded: finalReached,
        domLoaded: domUsable,
        domLoadedMs: domLoadedAt > 0 ? domLoadedAt : undefined,
        loadMs: completeAt > 0 ? completeAt : undefined,
        swNoHeaders: usedSwGrace,
        status,
        error: finalReached ? undefined : navigationError ?? aborted,
      };
    },
    openedTabs: () => [...opened],
    events: () => events,
    dispose() {
      observers.delete(observer);
      if (observers.size === 0) navigationObservers.delete(tabId);
    },
  };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface ScreenshotClip {
  x: number;
  y: number;
  viewportX: number;
  viewportY: number;
  width: number;
  height: number;
  dpr: number;
}

export interface ScreenshotOptions {
  format?: 'jpeg' | 'png';
  quality?: number;
  maxWidth?: number;
  fullPage?: boolean;
  clip?: ScreenshotClip;
}

export interface Screenshot {
  mimeType: string;
  data: string;
  width: number;
  height: number;
  background?: boolean;
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function finalizeScreenshot(
  rawBytes: Uint8Array,
  mimeType: string,
  quality: number,
  maxWidth: number,
  background: boolean,
  crop?: { x: number; y: number; width: number; height: number },
): Promise<Screenshot> {
  const blob = new Blob([rawBytes as BlobPart], { type: mimeType });
  const bitmap = await createImageBitmap(blob);
  const srcX = crop ? Math.max(0, Math.round(crop.x)) : 0;
  const srcY = crop ? Math.max(0, Math.round(crop.y)) : 0;
  const srcW = crop ? Math.max(1, Math.min(bitmap.width - srcX, Math.round(crop.width))) : bitmap.width;
  const srcH = crop ? Math.max(1, Math.min(bitmap.height - srcY, Math.round(crop.height))) : bitmap.height;

  if (!crop && srcW <= maxWidth) {
    bitmap.close();
    return { mimeType, data: toBase64(rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) as ArrayBuffer), width: srcW, height: srcH, background };
  }

  const scale = Math.min(1, maxWidth / srcW, 16384 / srcH);
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new BridgeError('screenshot_failed', 'Canvas is unavailable for resizing.');
  }
  context.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, width, height);
  bitmap.close();
  const resized = await canvas.convertToBlob({ type: mimeType, quality: quality / 100 });
  return { mimeType, data: toBase64(await resized.arrayBuffer()), width, height, background };
}

/**
 * Captures the viewport, full scrollable page, or a specific element clip.
 * Uses background capture (CDP Page.captureScreenshot on Chromium, tabs.captureTab on Firefox)
 * whenever available so the user's active tab is not interrupted.
 */
export async function captureScreenshot(tab: chrome.tabs.Tab, options: ScreenshotOptions = {}): Promise<Screenshot> {
  const format = options.format === 'png' ? 'png' : 'jpeg';
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = Math.max(10, Math.min(100, Math.round(options.quality ?? 75)));
  const maxWidth = Math.max(320, Math.min(8192, Math.round(options.maxWidth ?? 1280)));

  // 1. Chromium background/fullPage/clip capture via DevTools Protocol
  if (isChromium && tab.id !== undefined && !isBlank(tabUrl(tab))) {
    let canAttach = false;
    try {
      assertScriptable(tab);
      canAttach = await cdp.ensureAttached(tab.id);
    } catch {
      canAttach = false;
    }
    if (canAttach) {
      try {
        let clip: cdp.CdpClip | undefined;
        let emulateSize: { width: number; height: number } | undefined;
        let beyond = false;
        const layout = await cdp.getLayoutMetrics(tab.id);
        if (options.clip) {
          clip = { x: options.clip.x, y: options.clip.y, width: options.clip.width, height: options.clip.height };
          beyond = true;
          const needW = Math.ceil(options.clip.x + options.clip.width);
          const needH = Math.ceil(options.clip.y + options.clip.height);
          if (needW > layout.viewportWidth || needH > layout.viewportHeight) {
            emulateSize = {
              width: Math.max(layout.viewportWidth, needW),
              height: Math.max(layout.viewportHeight, needH),
            };
          }
        } else if (options.fullPage) {
          const doc = await callFrame<{ width: number; height: number }>(tab, 0, 'pageMetrics').catch(() => undefined);
          const fullW = Math.max(layout.contentWidth, doc?.width ?? 0, layout.viewportWidth);
          const fullH = Math.max(layout.contentHeight, doc?.height ?? 0, layout.viewportHeight);
          clip = { x: 0, y: 0, width: fullW, height: fullH };
          emulateSize = { width: fullW, height: fullH };
          beyond = true;
        } else if (!tab.active) {
          clip = { x: layout.pageX, y: layout.pageY, width: layout.viewportWidth, height: layout.viewportHeight };
          emulateSize = { width: layout.viewportWidth, height: layout.viewportHeight };
          beyond = true;
        }
        const base64 = await cdp.captureScreenshot(tab.id, { format, quality, captureBeyondViewport: beyond, clip, emulateSize });
        return await finalizeScreenshot(fromBase64(base64), mimeType, quality, maxWidth, !tab.active);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        await cdp.detach(tab.id);
      }
    }
  }

  // 2. Firefox background/fullPage/clip capture via browser.tabs.captureTab
  const firefoxTabs = api.tabs as unknown as {
    captureTab?: (tabId: number, details?: Record<string, unknown>) => Promise<string>;
  };
  if (!isChromium && tab.id !== undefined && typeof firefoxTabs.captureTab === 'function') {
    let rect: { x: number; y: number; width: number; height: number } | undefined;
    if (options.clip) {
      rect = {
        x: options.clip.x,
        y: options.clip.y,
        width: Math.max(1, Math.min(options.clip.width, 8192)),
        height: Math.max(1, Math.min(options.clip.height, 16384)),
      };
    } else if (options.fullPage) {
      const m = await callFrame<{ width: number; height: number }>(tab, 0, 'pageMetrics');
      rect = {
        x: 0,
        y: 0,
        width: Math.max(1, Math.min(m.width, 8192)),
        height: Math.max(1, Math.min(m.height, 16384)),
      };
    }
    const details: Record<string, unknown> = format === 'png' ? { format } : { format, quality };
    if (rect) details.rect = rect;
    const dataUrl = await firefoxTabs.captureTab(tab.id, details);
    const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
    return await finalizeScreenshot(bytes, mimeType, quality, maxWidth, !tab.active);
  }

  // 3. Fallback: captureVisibleTab (activates the tab when needed)
  if (options.fullPage) {
    throw new BridgeError('unsupported_in_dom_mode', 'Full-page screenshots require Trusted Input (debugger) to remain enabled in the Browser Bridge popup.');
  }
  if (!tab.active) {
    await api.tabs.update(tab.id!, { active: true });
    await sleep(300);
  }
  let dataUrl = '';
  for (let attempt = 0; attempt < 3 && !dataUrl; attempt++) {
    try {
      dataUrl = await api.tabs.captureVisibleTab(tab.windowId, format === 'png' ? { format } : { format, quality });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2) throw new BridgeError('screenshot_failed', `Could not capture the tab (${message}). Make sure its window is not minimized.`);
      await sleep(600);
    }
  }
  const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  const crop = options.clip
    ? {
        x: options.clip.viewportX * options.clip.dpr,
        y: options.clip.viewportY * options.clip.dpr,
        width: options.clip.width * options.clip.dpr,
        height: options.clip.height * options.clip.dpr,
      }
    : undefined;
  return await finalizeScreenshot(bytes, mimeType, quality, maxWidth, false, crop);
}

export async function ensureMainWebMcp(tabId: number): Promise<void> {
  await api.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      files: ['webmcp.js'],
      world: 'MAIN',
    } as chrome.scripting.ScriptInjection<[], void>)
    .catch(() => undefined);
}

export interface WebMcpToolDescriptor {
  name: string;
  kind: 'imperative' | 'declarative';
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  consequentialHint: boolean;
  autoSubmit?: boolean;
}

export async function listWebMcpTools(tab: chrome.tabs.Tab): Promise<WebMcpToolDescriptor[]> {
  assertScriptable(tab);
  if (isBlank(tabUrl(tab)) || tab.id === undefined) return [];
  await ensureMainWebMcp(tab.id);

  let imperative: WebMcpToolDescriptor[] = [];
  try {
    const res = await api.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'MAIN',
      func: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hook = (globalThis as any).__bbWebMcp;
        return typeof hook?.list === 'function' ? hook.list() : [];
      },
    } as chrome.scripting.ScriptInjection<[], WebMcpToolDescriptor[]>);
    imperative = (res?.[0]?.result as WebMcpToolDescriptor[] | undefined) ?? [];
  } catch {
    imperative = [];
  }

  const declarative = await callFrame<WebMcpToolDescriptor[]>(tab, 0, 'discoverDeclarativeWebMcp').catch(
    () => [] as WebMcpToolDescriptor[],
  );

  const byName = new Map<string, WebMcpToolDescriptor>();
  for (const t of declarative) byName.set(t.name, t);
  for (const t of imperative) byName.set(t.name, t);
  return [...byName.values()];
}

export async function invokeWebMcpTool(
  tab: chrome.tabs.Tab,
  toolName: string,
  args: Record<string, unknown>,
  requireReadOnly: boolean,
  submit?: boolean,
): Promise<unknown> {
  assertScriptable(tab);
  if (tab.id === undefined) throw new BridgeError('no_tab', 'Tab id is missing.');
  await ensureMainWebMcp(tab.id);

  const impResults = await api.scripting
    .executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'MAIN',
      func: async (name: string, input: Record<string, unknown>, ro: boolean) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hook = (globalThis as any).__bbWebMcp;
          if (typeof hook?.call !== 'function') return { found: false };
          const outcome = await hook.call(name, input, ro);
          if (!outcome?.found) return { found: false };
          if (outcome.blockedReadOnly) return outcome;
          return {
            found: true,
            kind: 'imperative',
            result: outcome.result === undefined ? null : JSON.parse(JSON.stringify(outcome.result)),
          };
        } catch (err) {
          return { found: true, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
        }
      },
      args: [toolName, args, requireReadOnly],
    } as unknown as chrome.scripting.ScriptInjection<
      [string, Record<string, unknown>, boolean],
      { found: boolean; blockedReadOnly?: boolean; error?: string; kind?: string; result?: unknown }
    >)
    .catch(() => undefined);

  const imp = impResults?.[0]?.result;
  if (imp?.found) {
    if (imp.blockedReadOnly) throw new BridgeError('read_only', imp.error ?? 'Blocked by read-only mode.');
    if (imp.error) throw new BridgeError('webmcp_error', imp.error);
    return { kind: 'imperative', tool: toolName, result: imp.result ?? null };
  }

  const decl = await callFrame<{
    found: boolean;
    blockedReadOnly?: boolean;
    error?: string;
    filled?: string[];
    submitted?: boolean;
  }>(tab, 0, 'callDeclarativeWebMcp', [toolName, args, requireReadOnly, submit]);

  if (!decl.found) {
    throw new BridgeError('not_found', `No WebMCP tool named "${toolName}" is registered on this page.`);
  }
  if (decl.blockedReadOnly) {
    throw new BridgeError('read_only', decl.error ?? 'Blocked by read-only mode.');
  }
  return { kind: 'declarative', tool: toolName, filled: decl.filled ?? [], submitted: decl.submitted === true };
}

export interface PageConsoleEntry {
  seq: number;
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  line?: number;
}

export async function readPageConsole(
  tab: chrome.tabs.Tab,
  options: { level?: string; limit?: number; clear?: boolean; clearOnly?: boolean } = {},
): Promise<{ total: number; entries: PageConsoleEntry[]; cleared?: number }> {
  assertScriptable(tab);
  if (tab.id === undefined) throw new BridgeError('no_tab', 'Tab id is missing.');
  await ensureMainWebMcp(tab.id);
  const res = await api.scripting
    .executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'MAIN',
      func: (lvl: string, lim: number, clr: boolean, clrOnly: boolean) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hook = (globalThis as any).__bbConsole;
        if (!hook) return { total: 0, entries: [] };
        if (clrOnly) {
          const out = hook.clear();
          return { total: 0, entries: [], cleared: out?.cleared ?? 0 };
        }
        return hook.read(lvl, lim, clr);
      },
      args: [options.level ?? 'all', options.limit ?? 100, Boolean(options.clear), Boolean(options.clearOnly)],
    } as unknown as chrome.scripting.ScriptInjection<
      [string, number, boolean, boolean],
      { total: number; entries: PageConsoleEntry[]; cleared?: number }
    >)
    .catch((err) => {
      throw new BridgeError('script_error', `Could not read page console: ${err instanceof Error ? err.message : String(err)}`);
    });
  return res?.[0]?.result ?? { total: 0, entries: [] };
}

export async function armMainDialog(tabId: number, accept: boolean, promptText?: string): Promise<void> {
  await api.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: (acc: boolean, text: string | null) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        if (!w.__bbOrigDialogs) {
          w.__bbOrigDialogs = {
            alert: w.alert?.bind(w),
            confirm: w.confirm?.bind(w),
            prompt: w.prompt?.bind(w),
          };
        }
        w.__bbNextDialog = { accept: acc, promptText: text, last: null };
        w.alert = (msg?: unknown) => {
          if (w.__bbNextDialog) {
            const d = w.__bbNextDialog;
            w.__bbNextDialog = null;
            w.__bbLastDialog = { type: 'alert', message: String(msg ?? ''), handled: true };
            void d;
            return;
          }
          return w.__bbOrigDialogs.alert?.(msg);
        };
        w.confirm = (msg?: unknown) => {
          if (w.__bbNextDialog) {
            const d = w.__bbNextDialog;
            w.__bbNextDialog = null;
            w.__bbLastDialog = { type: 'confirm', message: String(msg ?? ''), accepted: d.accept };
            return Boolean(d.accept);
          }
          return w.__bbOrigDialogs.confirm?.(msg);
        };
        w.prompt = (msg?: unknown, def?: string) => {
          if (w.__bbNextDialog) {
            const d = w.__bbNextDialog;
            w.__bbNextDialog = null;
            w.__bbLastDialog = { type: 'prompt', message: String(msg ?? ''), accepted: d.accept };
            return d.accept ? (d.promptText ?? def ?? '') : null;
          }
          return w.__bbOrigDialogs.prompt?.(msg, def);
        };
      },
      args: [accept, promptText ?? null],
    } as chrome.scripting.ScriptInjection<[boolean, string | null], void>)
    .catch(() => undefined);
}
