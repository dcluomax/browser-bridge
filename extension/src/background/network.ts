import { api, isChromium } from '../shared/api.ts';
import { redactBodyText, redactHeaders, redactUrl } from './allowlist.ts';

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
  maxEntries: number;
  urlSubstring?: string;
  entries: Map<string, NetworkExchange>;
  order: string[];
}

interface RawRequestBody {
  formData?: Record<string, string[]>;
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
  listenersInstalled = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wr = api.webRequest as any;
  if (!wr) return;
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
  } catch {
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

  const reqHeaderOpts = isChromium ? ['requestHeaders', 'extraHeaders'] : ['requestHeaders'];
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
  } catch {
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
    } catch {
      // ignore unavailable listener in mock environments
    }
  }

  const respHeaderOpts = isChromium ? ['responseHeaders', 'extraHeaders'] : ['responseHeaders'];
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
  } catch {
    try {
      wr.onCompleted?.addListener(onResp, filter, ['responseHeaders']);
    } catch {
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
}

export function startNetworkCapture(
  tabId: number,
  options: { maxEntries?: number; urlInclude?: string; clear?: boolean } = {},
): { active: boolean; captured: number } {
  installListenersOnce();
  const maxEntries = Math.max(10, Math.min(Math.round(options.maxEntries ?? 200), 500));
  const urlSubstring = options.urlInclude?.trim().toLowerCase() || undefined;
  const existing = captures.get(tabId);
  if (existing && options.clear === false) {
    existing.active = true;
    existing.maxEntries = maxEntries;
    existing.urlSubstring = urlSubstring;
    return { active: true, captured: existing.order.length };
  }
  captures.set(tabId, {
    active: true,
    startedAt: Date.now(),
    maxEntries,
    urlSubstring,
    entries: new Map(),
    order: [],
  });
  return { active: true, captured: 0 };
}

export function readNetworkCapture(
  tabId: number,
  options: { stop?: boolean; clear?: boolean; onlyFailures?: boolean; limit?: number } = {},
): { active: boolean; totalCaptured: number; exchanges: NetworkExchange[] } {
  const cap = captures.get(tabId);
  if (!cap) {
    return { active: false, totalCaptured: 0, exchanges: [] };
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
