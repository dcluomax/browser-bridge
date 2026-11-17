export interface SharedTabPromptInput {
  tabId: number;
  url: string;
  title?: string;
  browser: string;
  instanceId: string;
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

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
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

/**
 * Builds a single-line, minimal-token prompt pointing any local AI agent to the exact
 * shared tabId, browser instance, URL, and local AGENT.md guide.
 */
export function buildAgentPrompt(input: SharedTabPromptInput): string {
  const guide = (input.agentGuide ?? '').trim() || defaultGuidePath();
  const browserTag = input.instanceId
    ? `${input.browser || 'browser'} ${input.instanceId}`
    : (input.browser || 'browser');
  const modePart = input.mode === 'read' ? ' [read-only]' : input.mode === 'write' ? ' [read-write]' : '';
  const cleanFocus = (input.focus ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const focusPart = cleanFocus ? ` [focus: "${cleanFocus}"]` : '';
  return `Browser Bridge tab ${input.tabId}${modePart} (${browserTag}): ${input.url}${focusPart} — read ${guide}`;
}
