import { api, isChromium } from '../shared/api.ts';
import { redactBodyText, redactHeaders, redactUrl } from './allowlist.ts';
import { evidenceUrl } from '../content/performance.ts';
import { BridgeError } from '../shared/protocol.ts';

export interface NetworkExchange {
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  startedAt: number;
  durationMs: number | null;
  status: number | null;
  ok: boolean | null;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
}

interface TabCapture {
  active: boolean;
  startedAt: number;
  owner?: string;
  droppedEntries: number;
  maxEntries: number;
  urlSubstring?: string;
  entries: Map<string, NetworkExchange>;
  order: string[];
}

interface RawRequestBody {
  formData?: Record<string, Array<string | ArrayBuffer>>;
  raw?: Array<{ bytes?: ArrayBuffer }>;
}

interface RawWebRequestDetails {
  requestId: string;
  tabId: number;
  method?: string;
  url: string;
  type: string;
  statusCode?: number;
  error?: string;
  requestBody?: RawRequestBody;
  requestHeaders?: Array<{ name: string; value?: string }>;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

const captures = new Map<number, TabCapture>();
let listenersInstalled = false;

function decodeRequestBody(body: RawRequestBody | undefined): string | undefined {
  if (!body) return undefined;
  if (body.formData) {
    const params = new URLSearchParams();
    for (const [key, vals] of Object.entries(body.formData)) {
      for (const v of vals ?? []) {
        if (typeof v === 'string') params.append(key, v);
        else params.append(key, `[binary ${v.byteLength} bytes]`);
      }
    }
    return redactBodyText(params.toString());
  }
  const firstRaw = body.raw?.[0]?.bytes;
  if (firstRaw && firstRaw.byteLength > 0 && firstRaw.byteLength <= 16_384) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(firstRaw);
      return redactBodyText(text);
    } catch {
      return `[binary ${firstRaw.byteLength} bytes]`;
    }
  }
  return undefined;
}

function ensureEntry(cap: TabCapture, details: { requestId: string; method?: string; url: string; type: string }): NetworkExchange | null {
  let existing = cap.entries.get(details.requestId);
  if (existing) return existing;
  if (cap.urlSubstring && !details.url.toLowerCase().includes(cap.urlSubstring)) {
    return null;
  }
  while (cap.order.length >= cap.maxEntries) {
    const oldest = cap.order.shift();
    if (oldest) cap.entries.delete(oldest);
    cap.droppedEntries++;
  }
  existing = {
    requestId: details.requestId,
    method: details.method ?? 'GET',
    url: redactUrl(details.url),
    resourceType: details.type,
    startedAt: Date.now(),
    durationMs: null,
    status: null,
    ok: null,
  };
  cap.entries.set(details.requestId, existing);
  cap.order.push(details.requestId);
  return existing;
}

function installListenersOnce(): void {
  if (listenersInstalled) return;
  const wr = api.webRequest;
  if (!wr?.onBeforeRequest || !wr.onCompleted || !wr.onErrorOccurred) {
    throw new BridgeError('unsupported', 'This browser does not provide the required network observation APIs.');
  }
  const filter = { urls: ['<all_urls>'] };

  try {
    wr.onBeforeRequest?.addListener(
      (details: RawWebRequestDetails) => {
        const cap = captures.get(details.tabId);
        if (!cap?.active) return undefined;
        const entry = ensureEntry(cap, details);
        if (entry) {
          const body = decodeRequestBody(details.requestBody);
          if (body) entry.requestBody = body;
        }
        return undefined;
      },
      filter,
      ['requestBody'],
    );
  } catch (error) {
    console.warn('Browser Bridge request body observation is unavailable; capturing metadata only:', error instanceof Error ? error.message : String(error));
    wr.onBeforeRequest?.addListener(
      (details: RawWebRequestDetails) => {
        const cap = captures.get(details.tabId);
        if (!cap?.active) return undefined;
        ensureEntry(cap, details);
        return undefined;
      },
      filter,
    );
  }

  const reqHeaderOpts: Array<'requestHeaders' | 'extraHeaders'> = isChromium ? ['requestHeaders', 'extraHeaders'] : ['requestHeaders'];
  try {
    wr.onSendHeaders?.addListener(
      (details: RawWebRequestDetails) => {
        const cap = captures.get(details.tabId);
        if (!cap?.active) return;
        const entry = ensureEntry(cap, details);
        if (entry && details.requestHeaders) {
          entry.requestHeaders = redactHeaders(details.requestHeaders);
        }
      },
      filter,
      reqHeaderOpts,
    );
  } catch (error) {
    console.warn('Browser Bridge extended request header observation is unavailable:', error instanceof Error ? error.message : String(error));
    try {
      wr.onSendHeaders?.addListener(
        (details: RawWebRequestDetails) => {
          const cap = captures.get(details.tabId);
          if (!cap?.active) return;
          const entry = ensureEntry(cap, details);
          if (entry && details.requestHeaders) {
            entry.requestHeaders = redactHeaders(details.requestHeaders);
          }
        },
        filter,
        ['requestHeaders'],
      );
    } catch (headerError) {
      console.warn('Browser Bridge request headers could not be observed:', headerError instanceof Error ? headerError.message : String(headerError));
    }
  }

  const respHeaderOpts: Array<'responseHeaders' | 'extraHeaders'> = isChromium ? ['responseHeaders', 'extraHeaders'] : ['responseHeaders'];
  const onResp = (details: RawWebRequestDetails) => {
    const cap = captures.get(details.tabId);
    if (!cap?.active) return undefined;
    const entry = ensureEntry(cap, details);
    if (entry) {
      const code = details.statusCode ?? 0;
      entry.status = code;
      entry.ok = code >= 200 && code < 400;
      entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
      if (details.responseHeaders) {
        entry.responseHeaders = redactHeaders(details.responseHeaders);
      }
    }
    return undefined;
  };
  try {
    wr.onCompleted?.addListener(onResp, filter, respHeaderOpts);
  } catch (error) {
    console.warn('Browser Bridge extended response header observation is unavailable:', error instanceof Error ? error.message : String(error));
    try {
      wr.onCompleted?.addListener(onResp, filter, ['responseHeaders']);
    } catch (headerError) {
      console.warn('Browser Bridge response headers could not be observed:', headerError instanceof Error ? headerError.message : String(headerError));
      wr.onHeadersReceived?.addListener(onResp, filter);
    }
  }

  wr.onErrorOccurred?.addListener((details: RawWebRequestDetails) => {
    const cap = captures.get(details.tabId);
    if (!cap?.active) return;
    const entry = ensureEntry(cap, details);
    if (entry) {
      entry.ok = false;
      entry.error = details.error;
      entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
    }
  }, filter);
  listenersInstalled = true;
}

export function startNetworkCapture(
  tabId: number,
  options: { maxEntries?: number; urlInclude?: string; clear?: boolean; owner?: string } = {},
): { active: boolean; captured: number } {
  installListenersOnce();
  const maxEntries = options.maxEntries ?? 200;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 500) {
    throw new BridgeError('bad_request', 'maxEntries must be an integer from 1 to 500.');
  }
  const urlSubstring = options.urlInclude?.trim().toLowerCase() || undefined;
  const existing = captures.get(tabId);
  if (existing && options.clear === false) {
    if (existing.owner !== options.owner) {
      throw new BridgeError('forbidden', 'The network capture belongs to another session. Start a new capture.');
    }
    existing.active = true;
    existing.maxEntries = maxEntries;
    existing.urlSubstring = urlSubstring;
    return { active: true, captured: existing.order.length };
  }
  captures.set(tabId, {
    active: true,
    startedAt: Date.now(),
    owner: options.owner,
    droppedEntries: 0,
    maxEntries,
    urlSubstring,
    entries: new Map(),
    order: [],
  });
  return { active: true, captured: 0 };
}

export function readNetworkCapture(
  tabId: number,
  options: { stop?: boolean; clear?: boolean; onlyFailures?: boolean; limit?: number; owner?: string } = {},
): { active: boolean; totalCaptured: number; exchanges: NetworkExchange[] } {
  const cap = captures.get(tabId);
  if (!cap) {
    return { active: false, totalCaptured: 0, exchanges: [] };
  }
  if (options.owner !== undefined && cap.owner !== options.owner) {
    throw new BridgeError('forbidden', 'The network capture belongs to another session. Start a new capture.');
  }
  if (options.stop) cap.active = false;
  const limit = Math.max(1, Math.min(Math.round(options.limit ?? 100), 500));
  let list = cap.order.map((id) => cap.entries.get(id)).filter((x): x is NetworkExchange => Boolean(x));
  const totalCaptured = list.length;
  if (options.onlyFailures) {
    list = list.filter((x) => x.error !== undefined || (x.status !== null && x.status >= 400));
  }
  if (list.length > limit) {
    list = list.slice(list.length - limit);
  }
  if (options.clear) {
    cap.entries.clear();
    cap.order.length = 0;
  }
  return { active: cap.active, totalCaptured, exchanges: list };
}

export function dropTabNetworkCapture(tabId: number): void {
  captures.delete(tabId);
}

export function dropOwnerNetworkCaptures(owner: string): void {
  for (const [tabId, capture] of captures) {
    if (capture.owner === owner) captures.delete(tabId);
  }
}

export function exportNetworkHar(tabId: number, owner: string, options: { limit?: number; onlyFailures?: boolean } = {}) {
  const capture = captures.get(tabId);
  if (!capture) throw new BridgeError('capture_required', 'Start browser_network capture, reproduce the issue, then export HAR. Export does not start capture.');
  if (capture.owner !== owner) throw new BridgeError('forbidden', 'The network capture belongs to another session.');
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new BridgeError('bad_request', 'HAR limit must be an integer from 1 to 500.');
  }
  const selected = readNetworkCapture(tabId, { limit, onlyFailures: options.onlyFailures });
  const entries = selected.exchanges.map((exchange) => ({
    startedDateTime: new Date(exchange.startedAt).toISOString(),
    time: exchange.durationMs ?? 0,
    request: {
      method: exchange.method,
      url: evidenceUrl(exchange.url),
      httpVersion: '',
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: exchange.status ?? 0,
      statusText: '',
      httpVersion: '',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: '', _sizeUnavailable: true },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: -1, wait: -1, receive: -1 },
    _resourceType: exchange.resourceType,
    _statusObserved: exchange.status !== null,
    _durationObserved: exchange.durationMs !== null,
    ...(exchange.error ? { _error: redactBodyText(exchange.error, 200) } : {}),
  }));
  return {
    log: {
      version: '1.2',
      creator: { name: 'Browser Bridge', version: api.runtime.getManifest().version },
      entries,
      _capture: {
        active: capture.active,
        startedDateTime: new Date(capture.startedAt).toISOString(),
        totalRetained: selected.totalCaptured,
        droppedEntries: capture.droppedEntries,
        truncated: entries.length < selected.totalCaptured || capture.droppedEntries > 0,
      },
      _omissions: [
        'Headers, cookies, bodies, query strings, fragments and URL credentials are omitted.',
        'Unobserved status/time/size use required HAR placeholders and explicit observation flags.',
        'Per-phase timings are unavailable (-1). Only observed request duration is measured.',
        'Redirect hops sharing one browser request ID are not separate entries.',
      ],
    },
  };
}
