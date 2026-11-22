import { api, isChromium } from '../shared/api.ts';
import { BridgeError } from '../shared/protocol.ts';
import { redactBodyText } from './allowlist.ts';
import * as cdp from './cdp.ts';

type Params = Record<string, unknown>;

export interface InterceptionRule {
  urlPattern: string;
  action: 'block' | 'fulfill';
  status?: number;
  body?: string;
  contentType?: string;
}

interface InterceptionState {
  owner: string;
  rules: InterceptionRule[];
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  handled: number;
}

const interceptions = new Map<number, InterceptionState>();
const INTERCEPTION_TTL_MS = 300_000;
const MAX_BODY_BYTES = 65_536;

function object(value: unknown, label: string): Params {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('bad_request', `${label} must be an object.`);
  }
  return value as Params;
}

export function validateInterceptionRules(value: unknown): InterceptionRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new BridgeError('bad_request', 'rules must contain from 1 to 16 entries.');
  }
  let totalBytes = 0;
  return value.map((raw) => {
    const rule = object(raw, 'Each interception rule');
    if (Object.keys(rule).some((key) => !['urlPattern', 'action', 'status', 'body', 'contentType'].includes(key))) {
      throw new BridgeError('bad_request', 'An interception rule contains unsupported fields.');
    }
    if (typeof rule.urlPattern !== 'string' || rule.urlPattern.length > 2048 || /[?#\s\\]/.test(rule.urlPattern)) {
      throw new BridgeError('bad_request', 'urlPattern must be a bounded HTTP(S) URL without query, fragment, whitespace or backslash.');
    }
    let url: URL;
    try {
      url = new URL(rule.urlPattern.replaceAll('*', 'wildcard'));
    } catch {
      throw new BridgeError('bad_request', 'urlPattern must be an absolute HTTP(S) URL.');
    }
    const authority = /^https?:\/\/([^/]+)/.exec(rule.urlPattern)?.[1];
    if (!['http:', 'https:'].includes(url.protocol) || !authority || authority.includes('*') || url.username || url.password) {
      throw new BridgeError('bad_request', 'Wildcards are allowed only in the URL path. URL credentials are not allowed.');
    }
    if (rule.action !== 'block' && rule.action !== 'fulfill') {
      throw new BridgeError('bad_request', 'Interception action must be block or fulfill.');
    }
    if (rule.action === 'block') {
      if (rule.status !== undefined || rule.body !== undefined || rule.contentType !== undefined) {
        throw new BridgeError('bad_request', 'block rules cannot include response fields.');
      }
      return { urlPattern: rule.urlPattern, action: 'block' };
    }
    const status = rule.status ?? 200;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
      throw new BridgeError('bad_request', 'A mocked response status must be an integer from 200 to 599.');
    }
    const body = rule.body ?? '';
    if (typeof body !== 'string') throw new BridgeError('bad_request', 'A mocked response body must be a string.');
    const bytes = new TextEncoder().encode(body).byteLength;
    totalBytes += bytes;
    if (bytes > MAX_BODY_BYTES || totalBytes > 262_144) {
      throw new BridgeError('bad_request', 'Mocked response bodies exceed the 64 KiB per-rule or 256 KiB total limit.');
    }
    const contentType = rule.contentType ?? 'application/json';
    if (typeof contentType !== 'string' || contentType.length > 128 || !/^[\w.+-]+\/[\w.+-]+(?:; charset=utf-8)?$/i.test(contentType)) {
      throw new BridgeError('bad_request', 'contentType must be a MIME type, optionally with charset=utf-8.');
    }
    return { urlPattern: rule.urlPattern, action: 'fulfill', status, body, contentType };
  });
}

export function matchesInterceptionPattern(pattern: string, url: string): boolean {
  const value = url.split('#')[0];
  const parts = pattern.split('*');
  if (parts.length === 1) return value === pattern;
  if (!value.startsWith(parts[0])) return false;
  let offset = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const index = value.indexOf(part, offset);
    if (index < 0) return false;
    offset = index + part.length;
  }
  const suffix = parts[parts.length - 1];
  return value.endsWith(suffix) && value.length - suffix.length >= offset;
}

async function requireDebugger(tabId: number): Promise<void> {
  if (!isChromium || !api.debugger) {
    throw new BridgeError('unsupported', 'This operation requires Chromium chrome.debugger. Firefox supports DOM/layout, HAR and browser performance evidence instead.');
  }
  if (!await cdp.ensureAttached(tabId)) {
    throw new BridgeError('debugger_unavailable', 'Debugger access is disabled, was dismissed, or is owned by another debugger. No fallback or automatic retry was used.');
  }
}

export async function readDebuggerMetrics(tabId: number) {
  await requireDebugger(tabId);
  await cdp.send(tabId, 'Performance.enable', {});
  const response = await cdp.send<{ metrics?: Array<{ name: string; value: number }> }>(tabId, 'Performance.getMetrics', {});
  if (!Array.isArray(response.metrics)) throw new BridgeError('protocol_error', 'The debugger did not return a metrics array.');
  const metrics = response.metrics.filter((entry) =>
    typeof entry.name === 'string' && entry.name.length <= 100 && typeof entry.value === 'number' && Number.isFinite(entry.value),
  ).slice(0, 100);
  return {
    source: 'chrome-debugger-performance',
    capturedAt: Date.now(),
    metrics,
    truncated: response.metrics.length > metrics.length,
    limitations: ['These are browser-maintained raw counters, not Web Vitals or Browser Bridge operation measurements.'],
  };
}

function publicState(state: InterceptionState | undefined) {
  return {
    active: Boolean(state),
    expiresAt: state?.expiresAt ?? null,
    handledRequests: state?.handled ?? 0,
    rules: state?.rules.map(({ urlPattern, action, status, contentType }) => ({ urlPattern, action, status, contentType })) ?? [],
  };
}

export async function clearInterception(tabId: number, owner?: string): Promise<void> {
  const state = interceptions.get(tabId);
  if (!state) return;
  if (owner !== undefined && state.owner !== owner) throw new BridgeError('forbidden', 'Interception rules belong to another session.');
  if (cdp.isAttached(tabId)) await cdp.send(tabId, 'Fetch.disable', {});
  clearTimeout(state.timer);
  if (interceptions.get(tabId) === state) interceptions.delete(tabId);
}

export function forgetInterception(tabId: number): void {
  const state = interceptions.get(tabId);
  if (state) clearTimeout(state.timer);
  interceptions.delete(tabId);
}

export async function clearOwnerInterceptions(owner: string): Promise<void> {
  const tabs = [...interceptions].filter(([, state]) => state.owner === owner).map(([tabId]) => tabId);
  const results = await Promise.allSettled(tabs.map((tabId) => clearInterception(tabId, owner)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) {
    throw new BridgeError('cleanup_failed', `${failures.length} interception cleanup operation(s) failed. ${failures.map((r) => String(r.reason)).join('; ')}`);
  }
}

export async function runInterception(tabId: number, owner: string, params: Params) {
  const action = params.action ?? 'list';
  const existing = interceptions.get(tabId);
  if (existing && existing.owner !== owner) throw new BridgeError('forbidden', 'Interception rules belong to another session.');
  if (action === 'list') return publicState(existing);
  if (action === 'clear') {
    await clearInterception(tabId, owner);
    return publicState(undefined);
  }
  if (action !== 'set') throw new BridgeError('bad_request', 'Interception action must be list, set or clear.');
  const rules = validateInterceptionRules(params.rules);
  if (!existing && (interceptions.size >= 32 || [...interceptions.values()].filter((state) => state.owner === owner).length >= 8)) {
    throw new BridgeError('quota_exceeded', 'Interception is limited to 8 tabs per session and 32 tabs overall.');
  }
  await requireDebugger(tabId);
  await cdp.send(tabId, 'Fetch.enable', { patterns: rules.map((rule) => ({ urlPattern: rule.urlPattern, requestStage: 'Request' })) });
  if (existing) clearTimeout(existing.timer);
  const expiresAt = Date.now() + INTERCEPTION_TTL_MS;
  const timer = setTimeout(() => {
    void clearInterception(tabId, owner).catch(async (error: unknown) => {
      console.error('Browser Bridge interception expiry failed:', redactBodyText(String(error), 300));
      await cdp.detach(tabId);
      forgetInterception(tabId);
    });
  }, INTERCEPTION_TTL_MS);
  interceptions.set(tabId, { owner, rules, expiresAt, timer, handled: 0 });
  return publicState(interceptions.get(tabId));
}

async function handlePausedRequest(tabId: number, raw: unknown): Promise<void> {
  const params = object(raw, 'Paused request');
  if (typeof params.requestId !== 'string') throw new BridgeError('protocol_error', 'A paused request has no request ID.');
  const request = object(params.request, 'Paused request metadata');
  const url = typeof request.url === 'string' ? request.url : '';
  const state = interceptions.get(tabId);
  const rule = state?.rules.find((candidate) => matchesInterceptionPattern(candidate.urlPattern, url));
  if (!rule || !state || Date.now() >= state.expiresAt) {
    await cdp.send(tabId, 'Fetch.continueRequest', { requestId: params.requestId });
    return;
  }
  if (rule.action === 'block') {
    await cdp.send(tabId, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
  } else {
    const bytes = new TextEncoder().encode(rule.body ?? '');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    await cdp.send(tabId, 'Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: rule.status,
      responseHeaders: [{ name: 'Content-Type', value: rule.contentType }, { name: 'Cache-Control', value: 'no-store' }],
      body: btoa(binary),
    });
  }
  state.handled++;
}

if (isChromium && api.debugger) {
  api.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) forgetInterception(source.tabId);
  });
  api.debugger.onEvent.addListener((source, method, params) => {
    if (method !== 'Fetch.requestPaused' || source.tabId === undefined) return;
    const tabId = source.tabId;
    void handlePausedRequest(tabId, params).catch(async (error: unknown) => {
      console.error('Browser Bridge request interception failed:', redactBodyText(String(error), 300));
      try {
        await clearInterception(tabId);
      } catch (cleanupError) {
        console.error('Browser Bridge could not disable failed interception:', redactBodyText(String(cleanupError), 300));
        await cdp.detach(tabId);
        forgetInterception(tabId);
      }
    });
  });
}
