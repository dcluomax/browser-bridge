import { api } from '../shared/api.ts';
import { BridgeError } from '../shared/protocol.ts';
import { assertScriptable } from './page.ts';

interface FetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}

interface FetchResult {
  status: number;
  url: string;
  headers: Record<string, string>;
  data: string;
  byteLength: number;
}

type FetchOutcome = { result: FetchResult } | { error: { code: string; message: string } };

// Serialized into the page's MAIN world: browser credentials and CORS apply normally.
async function fetchInPage(options: FetchOptions): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(options.url, {
      method: options.method, headers: options.headers, body: options.body,
      credentials: 'include', signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > options.maxBytes) {
      controller.abort();
      return { error: { code: 'body_too_large', message: `Response exceeds the ${options.maxBytes}-byte limit.` } };
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > options.maxBytes) {
          controller.abort();
          return { error: { code: 'body_too_large', message: `Response exceeds the ${options.maxBytes}-byte limit.` } };
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parts: string[] = [];
    for (let index = 0; index < bytes.length; index += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
    return {
      result: {
        status: response.status, url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        data: btoa(parts.join('')), byteLength: length,
      },
    };
  } catch (error) {
    return { error: { code: controller.signal.aborted ? 'timeout' : 'request_failed', message: error instanceof Error ? error.message : String(error) } };
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

export async function fetchFromPage(tab: chrome.tabs.Tab, params: Record<string, unknown>): Promise<FetchResult> {
  assertScriptable(tab);
  if (typeof params.url !== 'string') throw new BridgeError('bad_request', 'url is required.');
  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    throw new BridgeError('bad_request', 'Requests require an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BridgeError('bad_request', 'Requests require an absolute HTTP(S) URL without embedded credentials.');
  const method = params.method === undefined ? 'GET' : params.method;
  if (typeof method !== 'string' || !/^[A-Za-z]+$/.test(method)) throw new BridgeError('bad_request', 'method must be an HTTP method.');
  const maxBytes = params.maxBytes ?? 20 * 1024 * 1024;
  const timeoutMs = params.timeoutMs ?? 30_000;
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new BridgeError('bad_request', 'maxBytes must be an integer between 1 and 33554432.');
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new BridgeError('bad_request', 'timeoutMs must be between 1 and 600000.');
  if (params.body !== undefined && typeof params.body !== 'string') throw new BridgeError('bad_request', 'body must be a string.');
  const headers: Record<string, string> = {};
  if (params.headers !== undefined) {
    if (!params.headers || typeof params.headers !== 'object' || Array.isArray(params.headers)) throw new BridgeError('bad_request', 'headers must be an object of strings.');
    for (const [key, value] of Object.entries(params.headers)) {
      if (typeof value !== 'string') throw new BridgeError('bad_request', 'Header values must be strings.');
      headers[key] = value;
    }
  }
  let results: chrome.scripting.InjectionResult<FetchOutcome>[];
  try {
    results = await api.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [0] }, world: 'MAIN', func: fetchInPage,
      args: [{ url: url.href, method, headers, body: params.body, timeoutMs, maxBytes }],
    });
  } catch (error) {
    throw new BridgeError('request_failed', `Browser fetch could not run: ${error instanceof Error ? error.message : String(error)}. The tab may have navigated or closed.`);
  }
  const outcome = results[0]?.result;
  if (!outcome) throw new BridgeError('request_failed', 'The page returned no fetch result.');
  if ('error' in outcome) throw new BridgeError(outcome.error.code, outcome.error.message);
  return outcome.result;
}
