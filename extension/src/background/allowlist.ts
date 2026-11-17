import { BridgeError } from '../shared/protocol.ts';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
  'cf-access-jwt-assertion',
  'cf-access-client-secret',
]);

const SENSITIVE_FIELD_RE =
  /^(?:pass(?:word|wd|phrase)?|pwd|secret|client_secret|token|access_token|refresh_token|id_token|auth(?:_token)?|api[-_]?key|apikey|private[-_]?key|session(?:[-_]?id|[-_]?key)?|otp|totp|mfa|pin|cvv|cvc|csc|card[-_]?number|sig(?:nature)?|jwt|bearer)$/i;

const BEARER_OR_JWT_RE =
  /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gi;

export const REDACTED = '[REDACTED]';

export interface ChallengeDetection {
  kind: 'cloudflare' | 'captcha' | 'access_denied';
  summary: string;
  suggestHandoff: true;
}

/**
 * Validates and normalizes an array of allowed origin/domain patterns.
 * Accepted shapes:
 * - Full origin: `https://app.diagrams.net` or `http://127.0.0.1:8080`
 * - Wildcard subdomain: `*.github.com` or `https://*.github.com`
 * - Bare host: `diagrams.net` or `localhost:3000`
 */
export function normalizeAllowedOrigins(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new BridgeError('bad_request', 'allowedOrigins must be an array of origin or domain strings.');
  }
  const normalized: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new BridgeError('bad_request', 'Each allowedOrigins entry must be a string.');
    }
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed === '*') {
      return [];
    }
    // Wildcard host pattern: *.example.com or https://*.example.com
    const wildcardMatch = /^(?:(https?):\/\/)?\*\.([a-z0-9.-]+(?::\d+)?)(?:\/.*)?$/i.exec(trimmed);
    if (wildcardMatch) {
      const scheme = wildcardMatch[1] ? `${wildcardMatch[1].toLowerCase()}://` : '';
      const host = wildcardMatch[2].replace(/\.+$/, '');
      if (!host || !host.includes('.')) {
        throw new BridgeError('bad_request', `Invalid wildcard origin pattern "${entry}".`);
      }
      const pat = `${scheme}*.${host}`;
      if (!normalized.includes(pat)) normalized.push(pat);
      continue;
    }

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new BridgeError('bad_request', `Invalid allowed origin "${entry}".`);
      }
      if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
        throw new BridgeError('bad_request', `Unsupported protocol in allowedOrigins: "${parsed.protocol}".`);
      }
      const pat = parsed.protocol === 'file:' ? 'file://' : parsed.origin.toLowerCase();
      if (!normalized.includes(pat)) normalized.push(pat);
      continue;
    }

    // Bare host or host:port
    const hostOnly = trimmed.split('/')[0].replace(/\.+$/, '');
    if (!/^[a-z0-9.-]+(?::\d+)?$/.test(hostOnly)) {
      throw new BridgeError('bad_request', `Invalid host pattern in allowedOrigins: "${entry}".`);
    }
    if (!normalized.includes(hostOnly)) normalized.push(hostOnly);
  }
  return normalized;
}

function matchesSinglePattern(parsed: URL, pattern: string): boolean {
  if (pattern === 'file://') return parsed.protocol === 'file:';
  const origin = parsed.origin.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const hostPort = parsed.host.toLowerCase();

  if (pattern.includes('://*.')) {
    const [scheme, rest] = pattern.split('://*.');
    if (parsed.protocol !== `${scheme}:`) return false;
    return hostPort === rest || host === rest || host.endsWith(`.${rest}`);
  }
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return hostPort === suffix || host === suffix || host.endsWith(`.${suffix}`);
  }
  if (pattern.includes('://')) {
    return origin === pattern;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  return pattern.includes(':') ? hostPort === pattern : host === pattern;
}

/**
 * Checks whether `url` satisfies an allowlist. An empty pattern list means unrestricted.
 * `about:blank` is permitted for initial tab creation before navigating.
 */
export function isUrlAllowed(url: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  const trimmed = url.trim();
  if (!trimmed || /^about:blank$/i.test(trimmed)) return true;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return patterns.some((p) => matchesSinglePattern(parsed, p));
}

export function assertAllowedByLists(
  url: string,
  sessionAllowlist: readonly string[] | undefined,
  tabAllowlist: readonly string[] | undefined,
): void {
  if (sessionAllowlist && sessionAllowlist.length > 0 && !isUrlAllowed(url, sessionAllowlist)) {
    throw new BridgeError(
      'origin_blocked',
      `Navigation to "${url}" is blocked by the session allowlist (${sessionAllowlist.join(', ')}).`,
    );
  }
  if (tabAllowlist && tabAllowlist.length > 0 && !isUrlAllowed(url, tabAllowlist)) {
    throw new BridgeError(
      'origin_blocked',
      `Navigation to "${url}" is blocked by this tab's allowedOrigins (${tabAllowlist.join(', ')}).`,
    );
  }
}

export function redactScalarString(value: string): string {
  return value.replace(BEARER_OR_JWT_RE, REDACTED);
}

export function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) parsed.username = 'redacted';
    if (parsed.password) parsed.password = 'redacted';
    let mutated = false;
    for (const key of [...parsed.searchParams.keys()]) {
      const val = parsed.searchParams.get(key) ?? '';
      if (SENSITIVE_FIELD_RE.test(key) || BEARER_OR_JWT_RE.test(val)) {
        BEARER_OR_JWT_RE.lastIndex = 0;
        parsed.searchParams.set(key, REDACTED);
        mutated = true;
      }
      BEARER_OR_JWT_RE.lastIndex = 0;
    }
    const rebuilt = mutated ? parsed.toString().replace(/%5BREDACTED%5D/gi, REDACTED) : parsed.toString();
    return redactScalarString(rebuilt);
  } catch {
    return redactScalarString(rawUrl);
  }
}

export function redactHeaders(
  headers: ReadonlyArray<{ name: string; value?: string }> | Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: Array<[string, string]> = Array.isArray(headers)
    ? headers.map((h) => [h.name, h.value ?? ''])
    : Object.entries(headers as Record<string, string>);
  for (const [rawName, rawVal] of entries) {
    const lower = rawName.trim().toLowerCase();
    if (!lower) continue;
    if (SENSITIVE_HEADER_NAMES.has(lower) || SENSITIVE_FIELD_RE.test(lower)) {
      out[lower] = REDACTED;
    } else {
      out[lower] = redactScalarString(String(rawVal ?? '')).slice(0, 512);
    }
  }
  return out;
}

function redactJsonValue(val: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof val === 'string') return redactScalarString(val);
  if (Array.isArray(val)) return val.slice(0, 50).map((item) => redactJsonValue(item, depth + 1));
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_RE.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactJsonValue(v, depth + 1);
      }
    }
    return out;
  }
  return val;
}

export function redactBodyText(raw: string | undefined, maxChars = 2048): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(redactJsonValue(parsed)).slice(0, maxChars);
    } catch {
      // fall through to query/string redaction
    }
  }
  if (trimmed.includes('=') && !trimmed.includes('\n') && !trimmed.includes('<')) {
    try {
      const params = new URLSearchParams(trimmed);
      let hasKey = false;
      for (const k of [...params.keys()]) {
        hasKey = true;
        if (SENSITIVE_FIELD_RE.test(k)) params.set(k, REDACTED);
      }
      if (hasKey) {
        return redactScalarString(params.toString().replace(/%5BREDACTED%5D/gi, REDACTED)).slice(0, maxChars);
      }
    } catch {
      // ignore
    }
  }
  return redactScalarString(trimmed).slice(0, maxChars);
}

/**
 * Non-intrusive heuristic detection of bot challenges, interactive CAPTCHAs, and WAF blocks.
 * Never attempts to bypass or solve them; instructs the agent to hand the tab to the user via `browser_handoff`.
 */
export function detectBotChallenge(probe: {
  status?: number | null;
  url?: string;
  title?: string;
  textSample?: string;
  markers?: string[];
}): ChallengeDetection | null {
  const title = (probe.title ?? '').trim();
  const text = (probe.textSample ?? '').slice(0, 3000);
  const url = probe.url ?? '';
  const markers = new Set(probe.markers ?? []);

  if (
    markers.has('cloudflare-turnstile') ||
    /^(?:Just a moment\.\.\.|Attention Required! \| Cloudflare|请稍候…)$/i.test(title) ||
    url.includes('/cdn-cgi/challenge-platform') ||
    (/Checking if the site connection is secure|Verify you are human/i.test(text) && /cloudflare/i.test(text))
  ) {
    return {
      kind: 'cloudflare',
      summary: 'Cloudflare human-verification challenge detected. Call browser_handoff so the user can complete verification.',
      suggestHandoff: true,
    };
  }

  if (
    markers.has('recaptcha') ||
    markers.has('hcaptcha') ||
    markers.has('arkose') ||
    markers.has('datadome') ||
    url.includes('/sorry/index') ||
    url.includes('/errors/validateCaptcha') ||
    /Press & Hold to confirm you are a human|Please verify you are a human|Pardon Our Interruption|Enter the characters you see below|unusual traffic from your computer network/i.test(
      `${title}\n${text}`,
    )
  ) {
    return {
      kind: 'captcha',
      summary: 'Interactive CAPTCHA / anti-bot wall detected. Do not attempt to solve it; call browser_handoff for user completion.',
      suggestHandoff: true,
    };
  }

  if (
    (probe.status === 403 || probe.status === 429 || /Blocked by network security|Whoa there, pardner/i.test(text)) &&
    /^(?:Access Denied|403 Forbidden|429 Too Many Requests|Request Blocked|Error 1015|Error 1020)|Blocked by network security|Whoa there, pardner/i.test(
      `${title}\n${text.slice(0, 500)}`,
    )
  ) {
    return {
      kind: 'access_denied',
      summary: `HTTP ${probe.status} access-denied / rate-limit wall detected. Stop automated retries or hand off to the user.`,
      suggestHandoff: true,
    };
  }

  return null;
}
