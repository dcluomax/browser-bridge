export interface SharedTabPromptInput {
  tabId: number;
  url: string;
  title?: string;
  browser: string;
  instanceId: string;
  label?: string;
  agentGuide?: string;
  mode?: 'read' | 'write';
  focus?: string;
}

export function defaultGuidePath(userAgent = ''): string {
  const ua = userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return /Windows/i.test(ua)
    ? '%LOCALAPPDATA%\\BrowserBridge\\AGENT.md'
    : '~/.browser-bridge/AGENT.md';
}

function localFileBasename(parsed: URL): string {
  const segs = parsed.pathname.split('/').filter(Boolean);
  const raw = segs[segs.length - 1] || 'local-file';
  try {
    return decodeURIComponent(raw) || 'local-file';
  } catch {
    return raw;
  }
}

export function hostOfUrl(url: string): string {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'file:') return localFileBasename(parsed);
    if (parsed.protocol === 'about:') return `${parsed.protocol}${parsed.pathname}`;
    return parsed.hostname || trimmed.split(/[?#]/)[0];
  } catch {
    return trimmed.split(/[?#]/)[0].slice(0, 60);
  }
}

const RESTRICTED_PROTOCOLS = /^(chrome|edge|brave|opera|vivaldi|view-source|chrome-extension|moz-extension|devtools|chrome-search|chrome-untrusted|resource|jar):/i;
const RESTRICTED_ABOUT = /^about:(?!blank(?:[?#]|$))/i;
const WEB_STORES = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons|addons\.mozilla\.org)/i;

export function isShareableUrl(url: string | undefined): boolean {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return false;
  if (RESTRICTED_PROTOCOLS.test(trimmed) || RESTRICTED_ABOUT.test(trimmed) || WEB_STORES.test(trimmed)) {
    return false;
  }
  return true;
}

export function compactUrlForPrompt(rawUrl: string, maxPathChars = 36): string {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'file:') return localFileBasename(parsed);
    if (parsed.protocol === 'about:') return `${parsed.protocol}${parsed.pathname}`;
    const host = (parsed.hostname || trimmed).replace(/^www\./i, '');
    const cleanPath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
    if (!cleanPath) return host;
    const shortPath = cleanPath.length > maxPathChars ? `${cleanPath.slice(0, maxPathChars - 1)}…` : cleanPath;
    return `${host}${shortPath}`;
  } catch {
    return trimmed.split(/[?#]/)[0].slice(0, 60);
  }
}

function compactTitle(title: string | undefined, maxChars = 44): string {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trimEnd()}…` : clean;
}

function compactFocus(focus: string | undefined): string {
  const clean = (focus ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  if (!clean) return '';
  if (/^file:\/\//i.test(clean)) {
    return compactUrlForPrompt(clean, 44);
  }
  if (/^https?:\/\//i.test(clean) && (clean.length > 64 || /[?#]/.test(clean))) {
    return compactUrlForPrompt(clean, 44);
  }
  return clean.length > 100 ? `${clean.slice(0, 99).trimEnd()}…` : clean;
}

/**
 * Builds a single-line, ultra-compact prompt (~55-105 chars) pointing any local AI agent
 * to the shared tabId, access mode (RO/RW), browser[:label], and clean title/host without query-token or path bloat.
 */
export function buildAgentPrompt(input: SharedTabPromptInput): string {
  const browser = (input.browser || 'browser').trim();
  const cleanLabel = (input.label ?? '')
    .replace(/[\s[\]]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const browserTag = cleanLabel && cleanLabel.toLowerCase() !== browser.toLowerCase()
    ? `${browser}:${cleanLabel}`
    : browser;
  const modeCode = input.mode === 'read' ? 'RO' : input.mode === 'write' ? 'RW' : '';
  const headTokens = [`#${input.tabId}`, modeCode, browserTag].filter(Boolean).join(' ');

  const host = hostOfUrl(input.url).replace(/^www\./i, '');
  const title = compactTitle(input.title);
  let targetLabel: string;
  if (title && title.toLowerCase() !== host.toLowerCase() && title !== input.url) {
    targetLabel = host && !/^about:/i.test(host) ? `${title} (${host})` : title;
  } else {
    targetLabel = compactUrlForPrompt(input.url);
  }

  const focus = compactFocus(input.focus);
  const focusPart = focus ? ` [focus: "${focus}"]` : '';
  return `[Browser Bridge ${headTokens}] ${targetLabel}${focusPart}`;
}
