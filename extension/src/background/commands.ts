import { api, isChromium } from '../shared/api.ts';
import { extMessages, resolveLocale } from '../shared/i18n.ts';
import { parseKeyCombo } from '../shared/keys.ts';
import { parseLocator, type LocatedElements, type Locator } from '../shared/locators.ts';
import { BridgeError } from '../shared/protocol.ts';
import { assertAllowedByLists, detectBotChallenge, normalizeAllowedOrigins, type ChallengeDetection } from './allowlist.ts';
import * as cdp from './cdp.ts';
import {
  cancelTabInteractions,
  isTabWaitingHandoff,
  listActiveDemonstrations,
  listActiveHandoffs,
  resolveDemonstrationWait,
  resolveHandoffWait,
  startDemonstrationWait,
  startHandoffWait,
} from './handoff.ts';
import { dropTabNetworkCapture, readNetworkCapture, startNetworkCapture } from './network.ts';
import { inspectTabMedia } from './media.ts';
import {
  armMainDialog,
  assertScriptable,
  callAllFrames,
  callFrame,
  captureScreenshot,
  invokeWebMcpTool,
  isBlank,
  listWebMcpTools,
  readPageConsole,
  sleep,
  tabUrl,
  watchNavigation,
  type ScreenshotClip,
} from './page.ts';
import { settings } from './settings.ts';
import { fetchFromPage } from './requests.ts';
import type { TabRegistry } from './tabs.ts';

type Params = Record<string, unknown>;

interface SnapshotFrame {
  text: string;
  truncated: boolean;
  omittedNodes: number;
  visibleIframes?: number;
  url: string;
  title: string;
  isTop: boolean;
  width: number;
  height: number;
}

interface SiteRuntimeProfile {
  preferredWaitUntil?: 'load' | 'domcontentloaded' | 'commit';
  serviceWorkerNavigation?: boolean;
  hydrationSettleMs?: number;
  readinessQuietMs?: number;
  readinessSelector?: string;
  preferredSnapshotFrames?: 'top' | 'all';
  preferredInput?: 'trusted' | 'dom';
  actionSettleMs?: number;
  submitSettleMs?: number;
}

interface PointResult {
  x: number;
  y: number;
  covered: string | null;
}

interface NavigationResult {
  tabId: number | undefined;
  url: string;
  title: string;
  name?: string;
  group?: string;
  reused?: boolean;
  loaded?: boolean;
  status?: number | null;
  challenge?: ChallengeDetection;
  navigationEvents?: Array<Record<string, unknown>>;
  _telemetry?: Record<string, unknown>;
}

interface ActionResult {
  tabId: number;
  url: string;
  title: string;
  navigated: boolean;
  input: 'trusted' | 'dom';
  warnings: string[];
  openedTabs: number[];
  [key: string]: unknown;
}

const MAX_SNAPSHOT = 200_000;

function str(params: Params, key: string, required = false): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new BridgeError('bad_request', `Missing required parameter "${key}".`);
    return undefined;
  }
  if (typeof value !== 'string') throw new BridgeError('bad_request', `Parameter "${key}" must be a string.`);
  return value;
}

function num(params: Params, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new BridgeError('bad_request', `Parameter "${key}" must be a number.`);
  return n;
}

function bool(params: Params, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  return value === true || value === 'true';
}

export function parseRef(ref: string): { frameId: number; local: string } {
  const match = /^(?:f(\d+))?(e\d+)$/.exec(ref.trim());
  if (!match) throw new BridgeError('bad_ref', `Invalid ref "${ref}". Use a ref from browser_snapshot such as "e12" or "f3e7".`);
  return { frameId: match[1] ? Number(match[1]) : 0, local: match[2] };
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^about:blank$/i.test(trimmed)) return 'about:blank';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new BridgeError('bad_request', `"${input}" is not a valid URL.`);
  }
  if (!['http:', 'https:', 'file:', 'data:'].includes(url.protocol)) {
    throw new BridgeError('bad_request', `Navigation to ${url.protocol} URLs is not allowed. Use http(s) or file URLs.`);
  }
  return url.href;
}

function siteProfile(params: Params): SiteRuntimeProfile {
  const raw = params._siteProfile;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as SiteRuntimeProfile) : {};
}

function assertAllowedByAllowlistPreview(
  registry: TabRegistry,
  session: string,
  tabOrigins: readonly string[] | undefined,
  url: string,
): void {
  assertAllowedByLists(url, registry.sessions.get(session)?.allowedOrigins, tabOrigins);
}

async function useTrustedInput(tab: chrome.tabs.Tab, frameId: number, profile?: SiteRuntimeProfile): Promise<boolean> {
  if (profile?.preferredInput === 'dom') return false;
  if (!isChromium || frameId !== 0 || !settings().trustedInput) return false;
  return cdp.ensureAttached(tab.id!);
}

/**
 * Runs the trusted (DevTools input) path when available and falls back to DOM events if the
 * debugger fails or hangs. Content-script errors (stale ref, not editable, ...) are real failures.
 */
async function withInput<T>(
  tab: chrome.tabs.Tab,
  frameId: number,
  warnings: string[],
  trusted: () => Promise<T>,
  dom: () => Promise<T>,
  profile?: SiteRuntimeProfile,
): Promise<{ value: T; input: 'trusted' | 'dom'; cdpFallback: boolean }> {
  let cdpFallback = false;
  if (await useTrustedInput(tab, frameId, profile)) {
    try {
      return { value: await trusted(), input: 'trusted', cdpFallback: false };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      cdpFallback = true;
      warnings.push(`Trusted input failed (${error instanceof Error ? error.message : String(error)}); used DOM events instead.`);
      await cdp.detach(tab.id!);
    }
  }
  return { value: await dom(), input: 'dom', cdpFallback };
}

export class Commands {
  private readonly stagedUploads = new Map<string, Array<{ name: string; mimeType: string; chunks: string[] }>>();

  constructor(private readonly registry: TabRegistry) {}

  async run(session: string, method: string, params: Params): Promise<unknown> {
    if (params && typeof params === 'object' && '_noLearn' in params) {
      const { _noLearn: _ignored, ...rest } = params;
      params = rest;
    }
    if (bool(params, 'readOnly') === true && !Commands.isReadSafeMethod(method, params)) {
      throw new BridgeError(
        'read_only',
        `Operation "${method}" is blocked because this client is running in read-only mode.`,
      );
    }
    const trackedTab = num(params, 'tabId') ?? this.registry.sessions.get(session)?.currentTabId;
    if (trackedTab !== undefined && this.registry.grants.has(trackedTab)) {
      this.registry.beginTabCall(trackedTab);
    }
    try {
      switch (method) {
        case 'status': return await this.status(session);
        case 'tabs.list': return await this.tabsList(session);
        case 'tabs.inventory': return await this.tabsList(session, true);
        case 'tabs.new': return await this.tabsNew(session, params);
        case 'tabs.select': return await this.tabsSelect(session, params);
        case 'tabs.close': return await this.tabsClose(session, params);
        case 'session.allowlist': return await this.allowlist(session, params);
        case 'page.navigate': return await this.navigate(session, params);
        case 'page.history': return await this.history(session, params);
        case 'page.snapshot': return await this.snapshot(session, params);
        case 'page.text': return await this.text(session, params);
        case 'page.info': return await this.info(session, params);
        case 'page.activate': return await this.activate(session, params);
        case 'page.locate': return await this.locate(session, params);
        case 'page.query': return await this.query(session, params);
        case 'page.queryAll': return await this.queryAll(session, params);
        case 'page.media': return await this.media(session, params);
        case 'page.fetch': return await this.fetch(session, params);
        case 'page.click': return await this.click(session, params);
        case 'page.drag': return await this.drag(session, params);
        case 'page.check': return await this.check(session, params);
        case 'page.hover': return await this.hover(session, params);
        case 'page.type': return await this.type(session, params);
        case 'page.fill': return await this.fill(session, params);
        case 'page.select': return await this.select(session, params);
        case 'page.press': return await this.press(session, params);
        case 'page.scroll': return await this.scroll(session, params);
        case 'page.upload': return await this.upload(session, params);
        case 'page.dialog': return await this.dialog(session, params);
        case 'page.handoff': return await this.handoff(session, params);
        case 'page.demonstrate': return await this.demonstrate(session, params);
        case 'page.network': return await this.network(session, params);
        case 'page.console': return await this.console(session, params);
        case 'page.webmcp.list': return await this.webmcpList(session, params);
        case 'page.webmcp.call': return await this.webmcpCall(session, params);
        case 'page.waitFor': return await this.waitFor(session, params);
        case 'page.screenshot': return await this.screenshot(session, params);
        case 'page.evaluate': return await this.evaluate(session, params);
        default:
          throw new BridgeError('unknown_method', `Unknown method "${method}".`);
      }
    } finally {
      if (trackedTab !== undefined && this.registry.grants.has(trackedTab)) {
        this.registry.endTabCall(trackedTab);
      }
    }
  }

  private static isReadSafeMethod(method: string, params: Params): boolean {
    if (
      method === 'status' ||
      method === 'tabs.list' ||
      method === 'tabs.inventory' ||
      method === 'page.snapshot' ||
      method === 'page.text' ||
      method === 'page.info' ||
      method === 'page.locate' ||
      method === 'page.query' ||
      method === 'page.queryAll' ||
      method === 'page.media' ||
      method === 'page.waitFor' ||
      method === 'page.screenshot' ||
      method === 'page.network' ||
      method === 'page.console' ||
      method === 'page.webmcp.list' ||
      method === 'page.webmcp.call'
    ) {
      return true;
    }
    if (method === 'session.allowlist') {
      return params.origins === undefined && bool(params, 'clear') !== true;
    }
    if (method === 'page.fetch') {
      const httpMethod = String(params.method ?? 'GET').toUpperCase();
      return httpMethod === 'GET' || httpMethod === 'HEAD';
    }
    return false;
  }

  private async status(session: string) {
    const tabs = await this.registry.accessibleTabs(session);
    const s = settings();
    return {
      accessAllTabs: s.accessAllTabs,
      readOnlyMode: s.readOnlyMode,
      trustedInput: s.trustedInput && cdp.trustedInputSupported(),
      trustedInputSupported: cdp.trustedInputSupported(),
      allowEvaluate: s.allowEvaluate,
      label: s.label,
      accessibleTabs: tabs.length,
      sessions: this.registry.sessions.size,
      currentTabId: this.registry.sessions.get(session)?.currentTabId ?? null,
      managedApi: 1,
      sharedTabInventory: 1,
      advancedScreenshot: 1,
      webMcp: 1,
      readWriteAcl: 1,
      backgroundTabGroups: isChromium && settings().groupAgentTabs ? 1 : 0,
      idleCloseMinutes: s.idleCloseMinutes,
      handoffAndDemonstrate: 1,
      networkAndConsole: 1,
    };
  }

  private async tabsList(session: string, inventory = false) {
    const tabs = inventory ? await this.registry.sharedTabs(session) : await this.registry.accessibleTabs(session);
    const current = this.registry.sessions.get(session)?.currentTabId;
    return {
      tabs: tabs
        .filter((t) => t.id !== undefined)
        .map((t) => {
          const grant = this.registry.grants.get(t.id!);
          return {
            tabId: t.id!,
            title: t.title ?? '',
            url: t.url ?? t.pendingUrl ?? '',
            active: Boolean(t.active),
            windowId: t.windowId,
            current: t.id === current,
            access: this.registry.ownerLabel(session, t.id!),
            mode: this.registry.effectiveMode(t.id!),
            ...(grant?.name ? { name: grant.name } : {}),
            ...(grant?.groupTitle ? { group: grant.groupTitle } : {}),
            ...(grant?.lastUsedAt ? { lastUsedAt: grant.lastUsedAt } : {}),
            ...(grant?.allowedOrigins?.length ? { allowedOrigins: grant.allowedOrigins } : {}),
            running: this.registry.isTabBusyRunning(t.id!),
            waitingHandoff: isTabWaitingHandoff(t.id!),
            ...(inventory ? {
              controllable: this.registry.canAccess(session, t.id!),
              busy: !this.registry.canAccess(session, t.id!),
              sharedByUser: grant?.source === 'user',
            } : {}),
          };
        }),
    };
  }

  private async tabsNew(session: string, params: Params): Promise<NavigationResult> {
    this.registry.requireGlobalWrite('tabs.new');
    const url = str(params, 'url');
    const target = url ? normalizeUrl(url) : 'about:blank';
    const name = str(params, 'name')?.trim() || undefined;
    const requestedGroup = str(params, 'group')?.trim() || undefined;
    const allowedOrigins = params.allowedOrigins !== undefined ? normalizeAllowedOrigins(params.allowedOrigins) : undefined;
    const tabMode = bool(params, 'readOnlyTab') === true ? 'read' : 'write';

    // Persistent named tab reuse: returns existing named tab without re-navigating if already loaded.
    if (name) {
      const existingGrant = this.registry.findNamedTab(session, name);
      if (existingGrant) {
        const existingTab = await api.tabs.get(existingGrant.tabId).catch(() => undefined);
        if (existingTab?.id !== undefined) {
          if (allowedOrigins !== undefined) this.registry.setTabAllowlist(existingTab.id, allowedOrigins);
          this.registry.claim(session, existingTab.id);
          this.registry.touch(existingTab.id);
          if (target !== 'about:blank' && isBlank(tabUrl(existingTab))) {
            return this.navigate(session, {
              url: target,
              tabId: existingTab.id,
              timeoutMs: params.timeoutMs,
              waitUntil: params.waitUntil,
              _siteProfile: params._siteProfile,
            });
          }
          return {
            tabId: existingTab.id,
            url: tabUrl(existingTab),
            title: existingTab.title ?? '',
            name,
            ...(existingGrant.groupTitle ? { group: existingGrant.groupTitle } : {}),
            reused: true,
            loaded: true,
            status: null,
          };
        }
        this.registry.onTabRemoved(existingGrant.tabId);
      }
    }

    if (target !== 'about:blank') {
      assertAllowedByAllowlistPreview(this.registry, session, allowedOrigins, target);
    }

    // Open in the background by default (active: false) so agents never steal foreground focus.
    const active = bool(params, 'active') ?? false;
    const tab = await api.tabs.create({ url: 'about:blank', active });
    const groupedTitle = await this.registry.groupAgentTab(tab, requestedGroup);
    this.registry.grant(tab.id!, 'agent', session, undefined, tabMode, {
      name,
      groupTitle: groupedTitle ?? requestedGroup,
      allowedOrigins,
    });
    this.registry.claim(session, tab.id!);
    if (target !== 'about:blank') {
      const nav = await this.navigate(session, {
        url: target,
        tabId: tab.id,
        timeoutMs: params.timeoutMs,
        waitUntil: params.waitUntil,
        _siteProfile: params._siteProfile,
      });
      return {
        ...nav,
        ...(name ? { name } : {}),
        ...((groupedTitle ?? requestedGroup) ? { group: groupedTitle ?? requestedGroup } : {}),
      };
    }
    return {
      tabId: tab.id,
      url: 'about:blank',
      title: '',
      ...(name ? { name } : {}),
      ...((groupedTitle ?? requestedGroup) ? { group: groupedTitle ?? requestedGroup } : {}),
    };
  }

  private async tabsSelect(session: string, params: Params) {
    this.registry.requireGlobalWrite('tabs.select');
    const named = str(params, 'name')?.trim();
    const tabId = num(params, 'tabId') ?? (named ? this.registry.findNamedTab(session, named)?.tabId : undefined);
    if (tabId === undefined) throw new BridgeError('bad_request', 'Missing required parameter "tabId" (or "name").');
    const tab = await this.registry.requireTab(session, tabId);
    this.registry.requireTabWrite(tab.id!, 'tabs.select');
    await api.tabs.update(tab.id!, { active: true });
    return { tabId: tab.id, url: tabUrl(tab), title: tab.title ?? '' };
  }

  private async closeSingleTabSafely(tab: chrome.tabs.Tab): Promise<number> {
    const id = tab.id!;
    cancelTabInteractions(id);
    dropTabNetworkCapture(id);
    await api.scripting
      .executeScript({
        target: { tabId: id, frameIds: [0] },
        world: 'MAIN',
        func: () => {
          window.onbeforeunload = null;
        },
      } as chrome.scripting.ScriptInjection<[], void>)
      .catch(() => undefined);
    await cdp.detach(id);
    // Never quit the browser process when closing the last tab in a window.
    const siblings = await api.tabs.query(tab.windowId !== undefined ? { windowId: tab.windowId } : {}).catch(() => [tab, tab]);
    if (siblings.length <= 1) {
      await api.tabs.create({
        url: 'about:blank',
        active: false,
        ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
      }).catch(() => undefined);
    }
    await api.tabs.remove(id);
    this.registry.onTabRemoved(id);
    return id;
  }

  private async tabsClose(session: string, params: Params) {
    this.registry.requireGlobalWrite('tabs.close');
    const groupName = str(params, 'group')?.trim();
    if (groupName) {
      const closedIds: number[] = [];
      for (const grant of [...this.registry.grants.values()]) {
        if (grant.source === 'agent' && grant.groupTitle === groupName && this.registry.canAccess(session, grant.tabId)) {
          const t = await api.tabs.get(grant.tabId).catch(() => undefined);
          if (t?.id !== undefined) closedIds.push(await this.closeSingleTabSafely(t));
          else this.registry.onTabRemoved(grant.tabId);
        }
      }
      return { closedGroup: groupName, closedTabs: closedIds };
    }
    const named = str(params, 'name')?.trim();
    const tabId = num(params, 'tabId') ?? (named ? this.registry.findNamedTab(session, named)?.tabId : undefined);
    const tab = await this.registry.resolveTab(session, tabId);
    this.registry.requireTabWrite(tab.id!, 'tabs.close');
    const closed = await this.closeSingleTabSafely(tab);
    return { closed };
  }

  private async allowlist(session: string, params: Params) {
    const tabId = num(params, 'tabId');
    const clear = bool(params, 'clear') === true;
    const hasUpdate = params.origins !== undefined || clear;
    if (hasUpdate) {
      this.registry.requireGlobalWrite('session.allowlist');
      const next = clear ? [] : normalizeAllowedOrigins(params.origins);
      if (tabId !== undefined) {
        const tab = await this.registry.requireTab(session, tabId);
        this.registry.requireTabWrite(tab.id!, 'session.allowlist');
        this.registry.setTabAllowlist(tab.id!, next);
      } else {
        this.registry.setSessionAllowlist(session, next);
      }
    }
    const { sessionOrigins, tabOrigins } = this.registry.effectiveAllowlist(session, tabId);
    return {
      session,
      ...(tabId !== undefined ? { tabId } : {}),
      sessionAllowedOrigins: sessionOrigins,
      ...(tabId !== undefined ? { tabAllowedOrigins: tabOrigins } : {}),
    };
  }

  private async navigate(session: string, params: Params): Promise<NavigationResult> {
    this.registry.requireGlobalWrite('page.navigate');
    const url = normalizeUrl(str(params, 'url', true)!);
    const timeout = num(params, 'timeoutMs') ?? 30_000;
    if (timeout < 1 || timeout > 600_000) throw new BridgeError('bad_request', 'timeoutMs must be between 1 and 600000.');
    const explicitWaitUntil = str(params, 'waitUntil');
    const prof = siteProfile(params);
    const waitUntil = explicitWaitUntil ?? prof.preferredWaitUntil ?? 'load';
    if (waitUntil !== 'load' && waitUntil !== 'domcontentloaded' && waitUntil !== 'commit') throw new BridgeError('bad_request', 'waitUntil must be load, domcontentloaded or commit.');
    if (bool(params, 'newTab')) return this.tabsNew(session, { ...params, url });
    const named = str(params, 'name')?.trim();
    const requestedTabId = num(params, 'tabId') ?? (named ? this.registry.findNamedTab(session, named)?.tabId : undefined);
    let tab: chrome.tabs.Tab;
    try {
      tab = await this.registry.resolveTab(session, requestedTabId);
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'no_tab' && requestedTabId === undefined) return this.tabsNew(session, { ...params, url });
      throw error;
    }
    this.registry.requireTabWrite(tab.id!, 'page.navigate');
    this.registry.assertNavigationAllowed(session, tab.id, url);
    const beforeUrl = tabUrl(tab);
    if (!isBlank(beforeUrl) && url.includes('#') && url.split('#')[0] === beforeUrl.split('#')[0] && tab.status === 'complete') {
      await api.tabs.update(tab.id!, { url });
      const after = await api.tabs.get(tab.id!);
      return { tabId: after.id, url: tabUrl(after) || url, title: after.title ?? '', loaded: true, status: null };
    }
    const trace = bool(params, 'navigationTrace') ?? false;
    const swGraceMs = prof.serviceWorkerNavigation ? 25 : 200;
    const watch = watchNavigation(tab.id!, url, trace);
    try {
      await api.tabs.update(tab.id!, { url });
      const nav = await watch.wait(3000, timeout, waitUntil, swGraceMs);
      if (nav.error) throw new BridgeError('navigation_failed', `Navigation failed: ${nav.error}${trace ? `; events=${JSON.stringify(watch.events())}` : ''}`);
      const loadTimedOutAfterDom = !nav.loaded && waitUntil === 'load' && Boolean(nav.domLoaded);
      const effectiveLoaded = nav.loaded || (explicitWaitUntil === undefined && loadTimedOutAfterDom);
      let after = await api.tabs.get(tab.id!);
      let finalUrl = tabUrl(after) || url;
      try {
        this.registry.assertNavigationAllowed(session, tab.id, finalUrl);
      } catch (err) {
        await api.tabs.update(tab.id!, { url: isBlank(beforeUrl) ? 'about:blank' : beforeUrl }).catch(() => undefined);
        throw err;
      }

      let settledMs: number | undefined;
      let settleReason: string | undefined;
      let contentChars: number | undefined;
      let mainChars: number | undefined;

      if (effectiveLoaded) {
        if (prof.hydrationSettleMs && prof.hydrationSettleMs > 0) {
          const capMs = Math.min(prof.hydrationSettleMs, 600);
          try {
            const quiet = await callFrame<{
              settled: boolean;
              waitedMs: number;
              reason: string;
              contentChars: number;
              mainChars: number;
            }>(after, 0, 'waitForDomQuiet', [
              {
                maxWaitMs: capMs,
                quietMs: prof.readinessQuietMs ?? 75,
                ...(prof.readinessSelector ? { selector: prof.readinessSelector } : {}),
              },
            ]);
            settledMs = typeof quiet?.waitedMs === 'number' ? quiet.waitedMs : 0;
            settleReason = typeof quiet?.reason === 'string' ? quiet.reason : 'quiet';
            if (typeof quiet?.contentChars === 'number') contentChars = quiet.contentChars;
            if (typeof quiet?.mainChars === 'number') mainChars = quiet.mainChars;
            if (settledMs > 0) {
              after = await api.tabs.get(tab.id!).catch(() => after);
              finalUrl = tabUrl(after) || url;
              try {
                this.registry.assertNavigationAllowed(session, tab.id, finalUrl);
              } catch (err) {
                await api.tabs.update(tab.id!, { url: isBlank(beforeUrl) ? 'about:blank' : beforeUrl }).catch(() => undefined);
                throw err;
              }
            }
          } catch {
            const fallbackMs = Math.min(prof.hydrationSettleMs, 120);
            await sleep(fallbackMs);
            settledMs = fallbackMs;
            settleReason = 'fallback_sleep';
          }
        } else {
          settledMs = 0;
          settleReason = 'already_ready';
        }
      }

      let challenge: ChallengeDetection | null = null;
      if (effectiveLoaded && /^https?:/i.test(finalUrl)) {
        const probe = await callFrame<{
          title: string;
          url: string;
          textSample: string;
          markers: string[];
          contentChars?: number;
          mainChars?: number;
        }>(
          after,
          0,
          'detectChallengeMarkers',
        ).catch(() => undefined);
        if (typeof probe?.contentChars === 'number') contentChars = probe.contentChars;
        if (typeof probe?.mainChars === 'number') mainChars = probe.mainChars;
        challenge = detectBotChallenge({
          status: nav.status,
          url: finalUrl,
          title: probe?.title ?? after.title,
          textSample: probe?.textSample,
          markers: probe?.markers,
        });
      }

      return {
        tabId: after.id,
        url: finalUrl,
        title: after.title ?? '',
        loaded: effectiveLoaded,
        status: nav.status,
        ...(challenge ? { challenge } : {}),
        ...(trace ? { navigationEvents: watch.events() } : {}),
        _telemetry: {
          domLoaded: Boolean(nav.domLoaded),
          loadTimedOut: loadTimedOutAfterDom,
          ...(nav.domLoadedMs !== undefined ? { domLoadedMs: nav.domLoadedMs } : {}),
          ...(nav.loadMs !== undefined ? { loadMs: nav.loadMs } : {}),
          ...(nav.swNoHeaders ? { swNoHeaders: true } : {}),
          ...(settledMs !== undefined ? { settledMs } : {}),
          ...(settleReason !== undefined ? { settleReason } : {}),
          ...(contentChars !== undefined ? { contentChars } : {}),
          ...(mainChars !== undefined ? { mainChars } : {}),
        },
      };
    } finally {
      watch.dispose();
    }
  }

  private async history(session: string, params: Params) {
    const action = str(params, 'action', true)!;
    if (action !== 'back' && action !== 'forward' && action !== 'reload') {
      throw new BridgeError('bad_request', 'action must be "back", "forward" or "reload".');
    }
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.history');
    const watch = watchNavigation(tab.id!);
    try {
      if (action === 'reload') {
        await api.tabs.reload(tab.id!);
      } else if (await useTrustedInput(tab, 0)) {
        const hist = await cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>(tab.id!, 'Page.getNavigationHistory');
        const nextIdx = action === 'back' ? hist.currentIndex - 1 : hist.currentIndex + 1;
        const entry = hist.entries?.[nextIdx];
        if (!entry) throw new BridgeError('navigation_failed', `Cannot go ${action}: no ${action} entry in tab history.`);
        await cdp.send(tab.id!, 'Page.navigateToHistoryEntry', { entryId: entry.id });
      } else if (action === 'back') {
        await api.tabs.goBack(tab.id!);
      } else {
        await api.tabs.goForward(tab.id!);
      }
      const nav = await watch.wait(2000, 30_000);
      const after = await api.tabs.get(tab.id!);
      return { tabId: after.id, url: tabUrl(after), title: after.title ?? '', navigated: nav.navigated };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('navigation_failed', `Cannot go ${action}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      watch.dispose();
    }
  }

  private async snapshot(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const maxChars = Math.max(1000, Math.min(num(params, 'maxChars') ?? 20_000, MAX_SNAPSHOT));
    const viewportOnly = bool(params, 'viewportOnly') ?? false;
    const header = `Tab ${tab.id}: ${tab.title ?? ''}\nURL: ${tabUrl(tab)}`;
    if (isBlank(tabUrl(tab))) {
      return {
        tabId: tab.id,
        text: `${header}\n(blank page)`,
        truncated: false,
        _telemetry: {
          visibleIframes: 0,
          childFramesScanned: 0,
          nonEmptyChildFrames: 0,
          contentChars: 0,
          truncated: false,
        },
      };
    }
    assertScriptable(tab);
    const root = str(params, 'root');
    const explicitFrames = str(params, 'frames');
    const prof = siteProfile(params);
    let frames: Array<{ frameId: number; result: SnapshotFrame }>;
    let visibleIframes = 0;
    let childFramesScanned = 0;
    let nonEmptyChildFrames = 0;
    if (root) {
      const { frameId, local } = parseRef(root);
      frames = [{ frameId, result: await callFrame<SnapshotFrame>(tab, frameId, 'snapshot', [{ maxChars, root: local, viewportOnly }]) }];
    } else if (explicitFrames === 'top') {
      const top = await callFrame<SnapshotFrame>(tab, 0, 'snapshot', [{ maxChars, viewportOnly }]);
      visibleIframes = top.visibleIframes ?? 0;
      frames = [{ frameId: 0, result: top }];
    } else if (explicitFrames === 'all') {
      frames = await callAllFrames<SnapshotFrame>(tab, 'snapshot', [{ maxChars, viewportOnly }]);
      visibleIframes = frames.find((f) => f.frameId === 0)?.result.visibleIframes ?? 0;
      childFramesScanned = Math.max(0, frames.length - 1);
    } else {
      const top = await callFrame<SnapshotFrame>(tab, 0, 'snapshot', [{ maxChars, viewportOnly }]);
      visibleIframes = top.visibleIframes ?? 0;
      if (visibleIframes === 0 || prof.preferredSnapshotFrames === 'top') {
        frames = [{ frameId: 0, result: top }];
      } else {
        const allOrTimeout = await Promise.race([
          callAllFrames<SnapshotFrame>(tab, 'snapshot', [{ maxChars, viewportOnly }]),
          sleep(1_500).then(() => null),
        ]);
        if (allOrTimeout) {
          frames = allOrTimeout;
          childFramesScanned = Math.max(0, frames.length - 1);
        } else {
          frames = [{ frameId: 0, result: top }];
          childFramesScanned = 1;
        }
      }
    }
    const parts: string[] = [header];
    let truncated = false;
    let used = header.length;
    let contentChars = 0;
    for (const { frameId, result } of frames) {
      if (frameId !== 0 && (!result.text.trim() || result.width * result.height === 0)) continue;
      if (frameId !== 0) nonEmptyChildFrames++;
      let text = frameId === 0 ? result.text : result.text.replace(/\[ref=(e\d+)\]/g, `[ref=f${frameId}$1]`);
      const sectionHeader = frameId === 0 ? '' : `\n# Frame f${frameId}: ${result.url}`;
      const budget = maxChars - used - sectionHeader.length;
      if (budget <= 200) {
        truncated = true;
        break;
      }
      if (text.length > budget) {
        text = text.slice(0, text.lastIndexOf('\n', budget) > 0 ? text.lastIndexOf('\n', budget) : budget);
        truncated = true;
      }
      if (result.truncated) truncated = true;
      contentChars += text.length;
      parts.push(sectionHeader ? `${sectionHeader}\n${text}` : text || '(no visible content)');
      used += sectionHeader.length + text.length + 1;
    }
    if (truncated) {
      parts.push('\n[Snapshot truncated. Use a larger maxChars, viewportOnly=true, or root=<ref> to focus on part of the page.]');
    }
    const challenge = detectBotChallenge({
      url: tabUrl(tab),
      title: tab.title,
      textSample: parts.slice(1, 3).join('\n').slice(0, 2000),
    });
    if (challenge) {
      parts.push(`\n[Bot Challenge Detected (${challenge.kind})]: ${challenge.summary}`);
    }
    return {
      tabId: tab.id,
      text: parts.join('\n'),
      truncated,
      ...(challenge ? { challenge } : {}),
      _telemetry: { visibleIframes, childFramesScanned, nonEmptyChildFrames, contentChars, truncated },
    };
  }

  private async text(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const maxChars = Math.max(500, Math.min(num(params, 'maxChars') ?? 20_000, 500_000));
    if (params.ref !== undefined || params.locator !== undefined) {
      const { frameId, local } = parseRef((await this.targetRef(session, tab, params))!);
      const result = await callFrame<{ value: string; truncated: boolean }>(tab, frameId, 'queryElement', [local, null, 'innerText', null, maxChars]);
      const extracted = typeof result.value === 'string' ? result.value : '';
      const isTruncated = Boolean(result.truncated);
      return {
        tabId: tab.id,
        url: tabUrl(tab),
        title: tab.title ?? '',
        text: extracted,
        truncated: isTruncated,
        _telemetry: { contentChars: extracted.length, truncated: isTruncated },
      };
    }
    if (isBlank(tabUrl(tab))) {
      return {
        tabId: tab.id,
        url: tabUrl(tab),
        title: tab.title ?? '',
        text: '',
        truncated: false,
        _telemetry: { contentChars: 0, truncated: false },
      };
    }
    const result = await callFrame<{ text: string; truncated: boolean; url: string; title: string }>(tab, 0, 'getText', [maxChars]);
    const contentChars = typeof result.text === 'string' ? result.text.length : 0;
    const isTruncated = Boolean(result.truncated);
    return { tabId: tab.id, ...result, _telemetry: { contentChars, truncated: isTruncated } };
  }

  private async info(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    if (bool(params, 'document')) {
      return { tabId: tab.id, ...await callFrame<Record<string, unknown>>(tab, 0, 'frameInfo') };
    }
    return { tabId: tab.id, url: tabUrl(tab), title: tab.title ?? '', status: tab.status };
  }

  private async fetch(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const httpMethod = String(params.method ?? 'GET').toUpperCase();
    if (httpMethod !== 'GET' && httpMethod !== 'HEAD') {
      this.registry.requireTabWrite(tab.id!, `page.fetch (${httpMethod})`);
    }
    return { tabId: tab.id, ...await fetchFromPage(tab, params) };
  }

  private async media(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    return await inspectTabMedia(tab, {
      includeAudio: bool(params, 'includeAudio') !== false,
      scrollIntoView: bool(params, 'scrollIntoView') !== false,
    });
  }

  private async activate(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    await api.tabs.update(tab.id!, { active: true });
    return { tabId: tab.id, url: tabUrl(tab), title: tab.title ?? '' };
  }

  private target(params: Params, required = true): { ref?: string; locator?: Locator } {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new BridgeError('bad_request', 'An element target must be an object.');
    const ref = str(params, 'ref');
    const locator = params.locator === undefined ? undefined : parseLocator(params.locator);
    if (ref && locator) throw new BridgeError('bad_request', 'Provide ref or locator, not both.');
    if (required && !ref && !locator) throw new BridgeError('bad_request', 'Provide an element ref or locator.');
    if (ref) parseRef(ref);
    return { ref, locator };
  }

  private async targetRef(session: string, tab: chrome.tabs.Tab, params: Params, readiness: 'attached' | 'visible' | 'enabled' | 'editable' = 'attached', required = true): Promise<string | undefined> {
    const { ref, locator } = this.target(params, required);
    if (ref || !locator) return ref;
    const timeout = num(params, 'timeoutMs') ?? 10_000;
    if (timeout < 1 || timeout > 600_000) throw new BridgeError('bad_request', 'Action timeoutMs must be between 1 and 600000.');
    const deadline = Date.now() + timeout;
    for (;;) {
      const current = await this.registry.requireTab(session, tab.id!);
      let result: LocatedElements | undefined;
      try {
        result = await callFrame<LocatedElements>(current, locator.frameId ?? 0, 'locate', [locator, 2]);
      } catch (err) {
        if (
          err instanceof BridgeError &&
          (err.code === 'not_ready' || err.code === 'script_error') &&
          Date.now() < deadline
        ) {
          await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
          continue;
        }
        throw err;
      }
      if (result.count > 1) throw new BridgeError('strict_locator', `Locator matched ${result.count} elements. Refine it or use nth/first/last.`);
      const el = result.elements[0];
      if (el && (readiness === 'attached' || (el.visible && (readiness === 'visible' || (el.enabled && (readiness !== 'editable' || el.editable)))))) {
        return locator.frameId ? `f${locator.frameId}${el.ref}` : el.ref;
      }
      if (Date.now() >= deadline) throw new BridgeError('timeout', `Timed out after ${timeout} ms waiting for one ${readiness} element.`);
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  private async locate(session: string, params: Params) {
    const locator = parseLocator(params.locator);
    const limit = num(params, 'maxResults') ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BridgeError('bad_request', 'maxResults must be an integer from 1 to 100.');
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const frameId = locator.frameId ?? 0;
    const result = await callFrame<LocatedElements>(tab, frameId, 'locate', [locator, limit]);
    return { tabId: tab.id, frameId, ...result, elements: result.elements.map((el) => ({ ...el, ref: frameId ? `f${frameId}${el.ref}` : el.ref })) };
  }

  private static normalizeElementOperation(raw: string): string {
    switch (raw.trim().toLowerCase()) {
      case 'inspect':
      case 'summary':
        return 'inspect';
      case 'count':
        return 'count';
      case 'innertext':
      case 'inner_text':
      case 'text':
        return 'innerText';
      case 'textcontent':
      case 'text_content':
        return 'textContent';
      case 'inputvalue':
      case 'input_value':
      case 'value':
        return 'inputValue';
      case 'getattribute':
      case 'get_attribute':
      case 'attribute':
      case 'attr':
        return 'getAttribute';
      case 'isvisible':
      case 'is_visible':
      case 'visible':
        return 'isVisible';
      case 'ishidden':
      case 'is_hidden':
      case 'hidden':
        return 'isHidden';
      case 'isenabled':
      case 'is_enabled':
      case 'enabled':
        return 'isEnabled';
      case 'isdisabled':
      case 'is_disabled':
      case 'disabled':
        return 'isDisabled';
      case 'iseditable':
      case 'is_editable':
      case 'editable':
        return 'isEditable';
      case 'ischecked':
      case 'is_checked':
      case 'checked':
        return 'isChecked';
      default:
        return raw;
    }
  }

  private async query(session: string, params: Params) {
    const { ref, locator } = this.target(params);
    const rawOp = str(params, 'operation') ?? 'inspect';
    const operation = Commands.normalizeElementOperation(rawOp);
    const allowed = ['inspect', 'count', 'innerText', 'textContent', 'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isEditable', 'isChecked'];
    if (!allowed.includes(operation)) {
      throw new BridgeError(
        'bad_request',
        `Unsupported element operation "${rawOp}". Valid operations: ${allowed.join(', ')}.`,
      );
    }
    const attribute = str(params, 'attribute', operation === 'getAttribute');
    if (attribute && operation !== 'getAttribute') throw new BridgeError('bad_request', 'attribute is only valid for operation=getAttribute.');
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const parsed = ref ? parseRef(ref) : { frameId: locator!.frameId ?? 0, local: null };
    const result = await callFrame<{ value: unknown; truncated?: boolean }>(tab, parsed.frameId, 'queryElement', [parsed.local, locator ?? null, operation, attribute ?? null, num(params, 'maxChars') ?? 20_000]);
    if (operation === 'inspect' && parsed.frameId && result.value && typeof result.value === 'object' && 'ref' in result.value) {
      result.value.ref = `f${parsed.frameId}${result.value.ref}`;
    }
    return { tabId: tab.id, ...result };
  }

  private async queryAll(session: string, params: Params) {
    const locator = parseLocator(params.locator);
    const operation = str(params, 'operation', true)!;
    if (!['textContent', 'innerText', 'getAttribute'].includes(operation)) throw new BridgeError('bad_request', 'Bulk reads support textContent, innerText or getAttribute.');
    const attribute = str(params, 'attribute', operation === 'getAttribute');
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const result = await callFrame<{ values: unknown[]; count: number; truncated: boolean }>(tab, locator.frameId ?? 0, 'queryAll', [locator, operation, attribute ?? null]);
    return { tabId: tab.id, ...result };
  }

  private async finishAction(
    tab: chrome.tabs.Tab,
    watch: ReturnType<typeof watchNavigation>,
    startMs: number,
    partial: Partial<ActionResult>,
    session: string,
    prof?: SiteRuntimeProfile,
  ): Promise<ActionResult> {
    const nav = await watch.wait(
      startMs,
      15_000,
      prof?.preferredWaitUntil ?? 'load',
      prof?.serviceWorkerNavigation ? 25 : 200,
    );
    const opened = watch.openedTabs();
    for (const id of opened) this.registry.grant(id, 'agent', session);
    const after = await api.tabs.get(tab.id!).catch(() => tab);
    return {
      tabId: tab.id!,
      url: tabUrl(after),
      title: after.title ?? '',
      navigated: nav.navigated,
      input: partial.input ?? 'dom',
      warnings: partial.warnings ?? [],
      openedTabs: opened,
      ...partial,
    } as ActionResult;
  }

  private async captureTargetTelemetry(
    tab: chrome.tabs.Tab,
    frameId: number,
    localRef: string | null,
    params: Params,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const explicitLocator = params.locator !== undefined ? parseLocator(params.locator) : undefined;
    if (explicitLocator) {
      out.semanticLocator = explicitLocator;
    }
    if (localRef) {
      const meta = await callFrame<{ locator?: Locator; sensitive: boolean; label: string }>(
        tab,
        frameId,
        'actionMeta',
        [localRef, !explicitLocator],
      ).catch(() => undefined);
      if (meta) {
        if (!explicitLocator && meta.locator) {
          out.semanticLocator = frameId ? { frameId, ...meta.locator } : meta.locator;
        }
        if (meta.sensitive) out.sensitive = true;
        if (meta.label) out.fieldLabel = meta.label;
      }
    }
    return out;
  }

  private async click(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.click');
    const prof = siteProfile(params);
    const { frameId, local } = parseRef((await this.targetRef(session, tab, params, 'enabled'))!);
    const targetTel = await this.captureTargetTelemetry(tab, frameId, local, params);
    const button = str(params, 'button') ?? 'left';
    const clickCount = bool(params, 'doubleClick') ? 2 : 1;
    const modifiers = Array.isArray(params.modifiers) ? (params.modifiers as string[]) : [];
    const warnings: string[] = [];
    const watch = watchNavigation(tab.id!);
    try {
      const { input, cdpFallback } = await withInput(tab, frameId, warnings, async () => {
        const point = await callFrame<PointResult>(tab, frameId, 'point', [local]);
        if (point.covered && params.locator) throw new BridgeError('not_actionable', `Locator target is ${point.covered}. No click was sent.`);
        if (point.covered) warnings.push(`The element was ${point.covered}; the click went to whatever is on top.`);
        await cdp.click(tab.id!, point.x, point.y, { button, clickCount, modifiers: cdp.modifierMaskFromNames(modifiers) });
      }, async () => {
        if (params.locator) {
          const point = await callFrame<PointResult>(tab, frameId, 'point', [local]);
          if (point.covered) throw new BridgeError('not_actionable', `Locator target is ${point.covered}. No click was sent.`);
        }
        const result = await callFrame<{ covered: string | null }>(tab, frameId, 'click', [local, { button, clickCount, modifiers }]);
        if (result.covered) warnings.push(`The element was ${result.covered}; it was clicked directly with DOM events.`);
      }, prof);
      const settleMs = prof.actionSettleMs ?? 80;
      const telemetry = { ...targetTel, ...(cdpFallback ? { cdpFallback: true } : {}) };
      return await this.finishAction(
        tab,
        watch,
        settleMs,
        { input, warnings, ...(Object.keys(telemetry).length ? { _telemetry: telemetry } : {}) },
        session,
        prof,
      );
    } finally {
      watch.dispose();
    }
  }

  private async drag(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.drag');
    const steps = Math.max(2, Math.min(Math.round(num(params, 'steps') ?? 10), 60));

    let fromX = num(params, 'fromX');
    let fromY = num(params, 'fromY');
    let frameId = 0;
    const fromTarget: Params = {};
    if (params.fromRef !== undefined) fromTarget.ref = params.fromRef;
    if (params.fromLocator !== undefined) fromTarget.locator = params.fromLocator;
    if (fromTarget.ref !== undefined || fromTarget.locator !== undefined) {
      const resolved = (await this.targetRef(session, tab, fromTarget, 'visible'))!;
      const parsed = parseRef(resolved);
      frameId = parsed.frameId;
      const pt = await callFrame<PointResult>(tab, frameId, 'point', [parsed.local]);
      fromX = pt.x + (num(params, 'fromOffsetX') ?? 0);
      fromY = pt.y + (num(params, 'fromOffsetY') ?? 0);
    }
    if (fromX === undefined || fromY === undefined) {
      throw new BridgeError('bad_request', 'Provide fromRef/fromLocator or explicit fromX and fromY coordinates.');
    }

    let toX = num(params, 'toX');
    let toY = num(params, 'toY');
    const toTarget: Params = {};
    if (params.toRef !== undefined) toTarget.ref = params.toRef;
    if (params.toLocator !== undefined) toTarget.locator = params.toLocator;
    if (toTarget.ref !== undefined || toTarget.locator !== undefined) {
      const resolved = (await this.targetRef(session, tab, toTarget, 'visible'))!;
      const parsed = parseRef(resolved);
      if (parsed.frameId !== frameId) {
        throw new BridgeError('bad_request', 'Drag source and destination must be in the same frame.');
      }
      const pt = await callFrame<PointResult>(tab, frameId, 'point', [parsed.local]);
      toX = pt.x + (num(params, 'toOffsetX') ?? 0);
      toY = pt.y + (num(params, 'toOffsetY') ?? 0);
    } else if (toX === undefined || toY === undefined) {
      const dx = num(params, 'dx');
      const dy = num(params, 'dy');
      if (dx !== undefined || dy !== undefined) {
        toX = fromX + (dx ?? 0);
        toY = fromY + (dy ?? 0);
      }
    }
    if (toX === undefined || toY === undefined) {
      throw new BridgeError('bad_request', 'Provide toRef/toLocator, explicit toX/toY, or relative dx/dy.');
    }

    const prof = siteProfile(params);
    const warnings: string[] = [];
    const watch = watchNavigation(tab.id!);
    try {
      const { input, cdpFallback } = await withInput(
        tab,
        frameId,
        warnings,
        async () => {
          if (frameId !== 0) throw new Error('CDP drag requires main frame');
          await cdp.drag(tab.id!, fromX!, fromY!, toX!, toY!, steps);
        },
        async () => {
          await callFrame(tab, frameId, 'drag', [fromX!, fromY!, toX!, toY!, steps]);
        },
        prof,
      );
      return await this.finishAction(
        tab,
        watch,
        prof.actionSettleMs ?? 80,
        {
          input,
          warnings,
          fromX: Math.round(fromX),
          fromY: Math.round(fromY),
          toX: Math.round(toX),
          toY: Math.round(toY),
          ...(cdpFallback ? { _telemetry: { cdpFallback: true } } : {}),
        },
        session,
        prof,
      );
    } finally {
      watch.dispose();
    }
  }

  private async hover(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.hover');
    const prof = siteProfile(params);
    const { frameId, local } = parseRef((await this.targetRef(session, tab, params, 'visible'))!);
    const warnings: string[] = [];
    const { input, cdpFallback } = await withInput(tab, frameId, warnings, async () => {
      const point = await callFrame<PointResult>(tab, frameId, 'point', [local]);
      if (point.covered && params.locator) throw new BridgeError('not_actionable', `Locator target is ${point.covered}. No hover was sent.`);
      if (point.covered) warnings.push(`The element was ${point.covered}.`);
      await cdp.hover(tab.id!, point.x, point.y);
    }, async () => {
      if (params.locator) {
        const point = await callFrame<PointResult>(tab, frameId, 'point', [local]);
        if (point.covered) throw new BridgeError('not_actionable', `Locator target is ${point.covered}. No hover was sent.`);
      }
      const result = await callFrame<{ covered: string | null }>(tab, frameId, 'hover', [local]);
      if (result.covered) warnings.push(`The element was ${result.covered}. DOM hover events cannot trigger CSS :hover styles.`);
    }, prof);
    await sleep(150);
    return { tabId: tab.id, input, warnings, ...(cdpFallback ? { _telemetry: { cdpFallback: true } } : {}) };
  }

  private async typeInto(
    tab: chrome.tabs.Tab,
    ref: string,
    text: string,
    options: { clear: boolean; slowly: boolean; submit: boolean },
    warnings: string[] = [],
    prof?: SiteRuntimeProfile,
  ): Promise<{ input: 'trusted' | 'dom'; value: string; inForm: boolean; cdpFallback: boolean }> {
    const { frameId, local } = parseRef(ref);
    const { value, input, cdpFallback } = await withInput(tab, frameId, warnings, async () => {
      const { kind, inForm } = await callFrame<{ kind: string; inForm: boolean }>(tab, frameId, 'focusForTyping', [local, options.clear]);
      if (kind === 'value') {
        await callFrame(tab, frameId, 'setValue', [local, text]);
      } else if (options.slowly) {
        await cdp.typeSlowly(tab.id!, text);
      } else if (text) {
        await cdp.insertText(tab.id!, text);
      }
      const current = await callFrame<{ value: string }>(tab, frameId, 'value', [local]);
      if (options.submit) await cdp.press(tab.id!, parseKeyCombo('Enter'));
      return { val: current.value, inForm };
    }, async () => {
      const res = await callFrame<{ value: string; inForm: boolean }>(tab, frameId, 'type', [local, text, options]);
      return { val: res.value, inForm: Boolean(res.inForm) };
    }, prof);
    return { input, value: value.val, inForm: value.inForm, cdpFallback };
  }

  private async type(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.type');
    const prof = siteProfile(params);
    const ref = (await this.targetRef(session, tab, params, 'editable'))!;
    const parsedRef = parseRef(ref);
    const targetTel = await this.captureTargetTelemetry(tab, parsedRef.frameId, parsedRef.local, params);
    const text = typeof params.text === 'string' ? params.text : String(params.text ?? '');
    const options = { clear: bool(params, 'clear') ?? true, slowly: bool(params, 'slowly') ?? false, submit: bool(params, 'submit') ?? false };
    const warnings: string[] = [];
    const watch = watchNavigation(tab.id!);
    try {
      const { input, value, inForm, cdpFallback } = await this.typeInto(tab, ref, text, options, warnings, prof);
      const settleMs = options.submit ? (prof.submitSettleMs ?? (inForm ? 900 : 90)) : 60;
      const telemetry = { ...targetTel, ...(cdpFallback ? { cdpFallback: true } : {}) };
      return await this.finishAction(
        tab,
        watch,
        settleMs,
        { input, value, warnings, ...(Object.keys(telemetry).length ? { _telemetry: telemetry } : {}) },
        session,
        prof,
      );
    } finally {
      watch.dispose();
    }
  }

  private async fill(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.fill');
    const fields = Array.isArray(params.fields) ? (params.fields as Array<{ ref?: string; locator?: Locator; value?: unknown }>) : [];
    if (!fields.length) throw new BridgeError('bad_request', 'fields must be a non-empty array of { ref or locator, value }.');
    for (const field of fields) this.target(field);
    const results: Array<{ ref: string; result: string }> = [];
    for (const field of fields) {
      const ref = (await this.targetRef(session, tab, field, 'enabled'))!;
      const value = typeof field.value === 'string' ? field.value : field.value === undefined ? '' : String(field.value);
      const { frameId, local } = parseRef(ref);
      const { checked } = await callFrame<{ checked: boolean | null }>(tab, frameId, 'isChecked', [local]);
      const { description } = await callFrame<{ description: string }>(tab, frameId, 'describe', [local]);
      if (/^<select/.test(description)) {
        const { selected } = await callFrame<{ selected: string[] }>(tab, frameId, 'select', [local, [value]]);
        results.push({ ref, result: `selected ${selected.join(', ')}` });
      } else if (checked !== null && /^(true|false|on|off|yes|no|checked|unchecked)$/i.test(value)) {
        const want = /^(true|on|yes|checked)$/i.test(value);
        if (want !== checked) await this.check(session, { tabId: tab.id, ...field, checked: want });
        results.push({ ref, result: want ? 'checked' : 'unchecked' });
      } else {
        const { value: finalValue } = await this.typeInto(tab, ref, value, { clear: true, slowly: false, submit: false });
        results.push({ ref, result: `value ${JSON.stringify(finalValue)}` });
      }
    }
    return { tabId: tab.id, fields: results };
  }

  private async select(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.select');
    const prof = siteProfile(params);
    const { frameId, local } = parseRef((await this.targetRef(session, tab, params, 'enabled'))!);
    const targetTel = await this.captureTargetTelemetry(tab, frameId, local, params);
    const values = Array.isArray(params.values) ? params.values.map(String) : typeof params.values === 'string' ? [params.values] : [];
    if (!values.length) throw new BridgeError('bad_request', 'values must contain at least one option value or label.');
    const watch = watchNavigation(tab.id!);
    try {
      const { selected } = await callFrame<{ selected: string[] }>(tab, frameId, 'select', [local, values]);
      return await this.finishAction(
        tab,
        watch,
        prof.actionSettleMs ?? 80,
        { selected, ...(Object.keys(targetTel).length ? { _telemetry: targetTel } : {}) },
        session,
        prof,
      );
    } finally {
      watch.dispose();
    }
  }

  private async check(session: string, params: Params) {
    if (typeof params.checked !== 'boolean') throw new BridgeError('bad_request', 'checked must be a boolean.');
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.check');
    const ref = (await this.targetRef(session, tab, params, 'enabled'))!;
    const { frameId, local } = parseRef(ref);
    const targetTel = await this.captureTargetTelemetry(tab, frameId, local, params);
    const before = await callFrame<{ checked: boolean | null }>(tab, frameId, 'isChecked', [local]);
    if (before.checked === null) throw new BridgeError('bad_request', 'The target is not a checkbox, radio or aria-checked element.');
    if (before.checked === params.checked) {
      return {
        tabId: tab.id,
        checked: before.checked,
        changed: false,
        ...(Object.keys(targetTel).length ? { _telemetry: targetTel } : {}),
      };
    }
    const action = await this.click(session, { ...params, tabId: tab.id });
    const after = await callFrame<{ checked: boolean | null }>(tab, frameId, 'isChecked', [local]);
    if (after.checked !== params.checked) throw new BridgeError('check_failed', 'The click did not produce the requested checked state.');
    return { ...action, checked: after.checked, changed: true };
  }

  private async press(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.press');
    const prof = siteProfile(params);
    const key = str(params, 'key', true)!;
    const keyPress = parseKeyCombo(key);
    const ref = await this.targetRef(session, tab, params, 'visible', false);
    let frameId = 0;
    let targetTel: Record<string, unknown> = {};
    if (ref) {
      const parsed = parseRef(ref);
      frameId = parsed.frameId;
      targetTel = await this.captureTargetTelemetry(tab, frameId, parsed.local, params);
      await callFrame(tab, frameId, 'focus', [parsed.local]);
    }
    const warnings: string[] = [];
    const watch = watchNavigation(tab.id!);
    try {
      const { input, cdpFallback } = await withInput(tab, frameId, warnings,
        () => cdp.press(tab.id!, keyPress),
        async () => { await callFrame(tab, frameId, 'press', [key]); },
        prof);
      const settleMs = keyPress.def.key === 'Enter'
        ? (prof.submitSettleMs ?? 800)
        : (prof.actionSettleMs ?? 80);
      const telemetry = { ...targetTel, ...(cdpFallback ? { cdpFallback: true } : {}) };
      return await this.finishAction(
        tab,
        watch,
        settleMs,
        { input, warnings, ...(Object.keys(telemetry).length ? { _telemetry: telemetry } : {}) },
        session,
        prof,
      );
    } finally {
      watch.dispose();
    }
  }

  private async scroll(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.scroll');
    const ref = await this.targetRef(session, tab, params, 'visible', false);
    const parsed = ref ? parseRef(ref) : { frameId: 0, local: null as string | null };
    const direction = str(params, 'direction') ?? (ref ? null : 'down');
    const result = await callFrame<{ scrollX: number; scrollY: number; atEnd: boolean }>(tab, parsed.frameId, 'scroll', [parsed.local, direction, num(params, 'amount') ?? 0.8]);
    return { tabId: tab.id, ...result };
  }

  private async waitFor(session: string, params: Params) {
    const seconds = num(params, 'seconds');
    const text = str(params, 'text');
    const textGone = str(params, 'textGone');
    const { ref, locator } = this.target(params, false);
    const state = str(params, 'state') ?? 'visible';
    const loadState = str(params, 'loadState');
    const url = str(params, 'url');
    const conditions = [text, textGone, ref || locator, loadState, url].filter(Boolean).length;
    if (conditions > 1 || (seconds === undefined && conditions === 0)) throw new BridgeError('bad_request', 'Provide one condition (text, textGone, ref/locator, loadState or url), optionally with seconds.');
    if (params.state !== undefined && !ref && !locator) throw new BridgeError('bad_request', 'state requires ref or locator.');
    if (!['attached', 'detached', 'visible', 'hidden', 'enabled', 'disabled', 'editable', 'checked', 'unchecked'].includes(state)) throw new BridgeError('bad_request', `Unsupported element state "${state}".`);
    if (loadState && !['load', 'domcontentloaded'].includes(loadState)) throw new BridgeError('bad_request', 'loadState must be load or domcontentloaded; networkidle is not supported.');
    if (seconds !== undefined && (seconds < 0 || seconds > 60)) throw new BridgeError('bad_request', 'seconds must be between 0 and 60.');
    const timeout = (num(params, 'timeoutSeconds') ?? 10) * 1000;
    if (timeout < 1 || timeout > 600_000) throw new BridgeError('bad_request', 'timeoutSeconds must be greater than 0 and at most 600.');
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    if (seconds !== undefined) await sleep(seconds * 1000);
    if (conditions === 0) {
      await this.registry.requireTab(session, tab.id!);
      return { tabId: tab.id, waited: seconds };
    }
    const deadline = Date.now() + timeout;
    const started = Date.now();
    const parsed = ref ? parseRef(ref) : { frameId: locator?.frameId ?? 0, local: null };
    for (;;) {
      const current = await this.registry.requireTab(session, tab.id!);
      try {
        if (ref || locator) {
          const result = await callFrame<{ matches: boolean; ref?: string }>(current, parsed.frameId, 'elementState', [parsed.local, locator ?? null, state]);
          if (result.matches) return { tabId: tab.id, state, elapsedMs: Date.now() - started };
        } else if (loadState) {
          const result = await callFrame<{ readyState: string }>(current, 0, 'frameInfo');
          if (result.readyState === 'complete' || (loadState === 'domcontentloaded' && result.readyState === 'interactive')) {
            return { tabId: tab.id, loadState, elapsedMs: Date.now() - started };
          }
        } else if (url) {
          if (tabUrl(current) === url) return { tabId: tab.id, url, elapsedMs: Date.now() - started };
        } else if (current.status === 'complete' || Date.now() - started > 1000) {
          const frames = await callAllFrames<boolean>(current, 'hasText', [text ?? textGone], true);
          if (!frames.some((frame) => frame.frameId === 0)) throw new BridgeError('script_error', 'The main frame could not be read while waiting for text.');
          const found = frames.some((frame) => frame.result);
          if (text && found) return { tabId: tab.id, found: text, elapsedMs: Date.now() - started };
          if (textGone && !found && current.status === 'complete') return { tabId: tab.id, gone: textGone, elapsedMs: Date.now() - started };
        }
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== 'not_ready') throw error;
      }
      if (Date.now() >= deadline) throw new BridgeError('timeout', `Timed out after ${timeout} ms waiting for ${text ? `text ${JSON.stringify(text)}` : textGone ? `text ${JSON.stringify(textGone)} to disappear` : ref || locator ? `element state ${state}` : loadState ? `load state ${loadState}` : `URL ${url}`}.`);
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  private async screenshot(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const format = str(params, 'format') === 'png' ? 'png' : 'jpeg';
    const fullPage = bool(params, 'fullPage') === true;
    const resolvedRef = await this.targetRef(session, tab, params, 'visible', false);
    if (fullPage && resolvedRef) {
      throw new BridgeError('bad_request', 'Provide fullPage or an element ref/locator, not both.');
    }

    let clip: ScreenshotClip | undefined;
    if (resolvedRef) {
      const { frameId, local } = parseRef(resolvedRef);
      const scrollFallback = isChromium && (!settings().trustedInput || !cdp.trustedInputSupported());
      const box = await callFrame<ScreenshotClip>(tab, frameId, 'box', [local, scrollFallback]);
      if (frameId === 0) {
        clip = box;
      } else {
        const info = await callFrame<{ url: string }>(tab, frameId, 'frameInfo');
        const offset = await callFrame<{ x: number; y: number; viewportX: number; viewportY: number } | null>(tab, 0, 'frameOffset', [info.url]);
        if (!offset) {
          throw new BridgeError('unsupported_frame', 'Could not map nested iframe coordinates uniquely; capture the main frame instead.');
        }
        clip = {
          x: box.x + offset.x,
          y: box.y + offset.y,
          viewportX: box.viewportX + offset.viewportX,
          viewportY: box.viewportY + offset.viewportY,
          width: box.width,
          height: box.height,
          dpr: box.dpr,
        };
      }
    }

    const shot = await captureScreenshot(tab, {
      format,
      quality: num(params, 'quality'),
      maxWidth: num(params, 'maxWidth'),
      fullPage,
      clip,
    });
    return { tabId: tab.id, ...shot };
  }

  private async upload(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.upload');

    const uploadId = str(params, 'uploadId') ?? `${session}:${tab.id}`;
    if (bool(params, 'reset') === true) {
      this.stagedUploads.delete(uploadId);
    }

    const fileName = str(params, 'fileName');
    const chunkBase64 = str(params, 'chunkBase64');
    if (fileName !== undefined || chunkBase64 !== undefined) {
      if (!fileName) throw new BridgeError('bad_request', 'fileName is required when staging upload data.');
      const mimeType = str(params, 'mimeType') ?? 'application/octet-stream';
      const append = bool(params, 'append') === true;
      const list = this.stagedUploads.get(uploadId) ?? [];
      if (append && list.length > 0 && list[list.length - 1].name === fileName) {
        if (chunkBase64) list[list.length - 1].chunks.push(chunkBase64);
      } else {
        list.push({ name: fileName, mimeType, chunks: chunkBase64 ? [chunkBase64] : [] });
      }
      this.stagedUploads.set(uploadId, list);
    }

    if (bool(params, 'commit') === false) {
      return { tabId: tab.id, staged: true, uploadId };
    }

    const staged = this.stagedUploads.get(uploadId) ?? [];
    this.stagedUploads.delete(uploadId);
    if (staged.length === 0) {
      throw new BridgeError('bad_request', 'No upload file payload was provided.');
    }

    const ref = (await this.targetRef(session, tab, params, 'enabled'))!;
    const { frameId, local } = parseRef(ref);
    const payload = staged.map((f) => ({
      name: f.name,
      mimeType: f.mimeType,
      base64: f.chunks.join(''),
    }));
    const result = await callFrame<{ files: string[] }>(tab, frameId, 'setFileInput', [local, payload]);
    return { tabId: tab.id, files: result.files };
  }

  private async dialog(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.dialog');
    const accept = bool(params, 'accept') ?? true;
    const promptText = typeof params.promptText === 'string' ? params.promptText : undefined;

    if (bool(params, 'armNext') === true) {
      await armMainDialog(tab.id!, accept, promptText);
      return { tabId: tab.id, armed: true, accept };
    }

    if (await useTrustedInput(tab, 0)) {
      const info = await cdp.handleDialog(tab.id!, accept, promptText);
      return { tabId: tab.id, handled: true, accept, dialog: info };
    }
    await armMainDialog(tab.id!, accept, promptText);
    return { tabId: tab.id, armed: true, accept };
  }

  private async handoff(session: string, params: Params) {
    const action = (str(params, 'action') ?? 'request').toLowerCase();
    if (action === 'status') {
      return { handoffs: listActiveHandoffs() };
    }
    if (action === 'resolve' || action === 'continue' || action === 'cancel') {
      const explicitId = num(params, 'tabId');
      const tab =
        explicitId !== undefined && isTabWaitingHandoff(explicitId)
          ? await api.tabs.get(explicitId).catch(() => undefined)
          : await this.registry.resolveTab(session, explicitId);
      if (!tab?.id) throw new BridgeError('no_tab', 'Target tab for handoff resolution does not exist.');
      const outcome = action === 'cancel' ? 'cancel' : 'continue';
      const resolvedId = resolveHandoffWait({ tabId: tab.id }, outcome);
      await callFrame(tab, 0, 'hideHandoffCard').catch(() => undefined);
      await this.registry.applyBadge(tab.id);
      return { tabId: tab.id, resolved: resolvedId !== null, action: outcome };
    }

    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const message =
      str(params, 'message') ??
      'Please complete the login, 2FA, or verification step in this tab, then click Continue.';
    const timeoutMs = Math.max(1_000, Math.min(num(params, 'timeoutMs') ?? 300_000, 600_000));
    const bringToFront = bool(params, 'bringToFront') !== false;
    if (bringToFront) {
      await api.tabs.update(tab.id!, { active: true }).catch(() => undefined);
    }

    const origin = (() => {
      try {
        return new URL(tabUrl(tab)).origin;
      } catch {
        return tabUrl(tab);
      }
    })();
    const loc = resolveLocale(settings().locale);
    const continueLabel = loc.startsWith('zh') ? '继续执行' : loc === 'ja' ? '続行' : 'Continue';
    const cancelLabel = loc.startsWith('zh') ? '取消' : loc === 'ja' ? 'キャンセル' : 'Cancel';

    const { id, promise } = startHandoffWait(tab.id!, session, origin, message, timeoutMs, () => {
      void this.registry.applyBadge(tab.id!);
      this.registry.onChange();
    });
    await callFrame(tab, 0, 'showHandoffCard', [{ id, origin, message, continueLabel, cancelLabel }]).catch(() => undefined);

    const outcome = await promise;
    await callFrame(tab, 0, 'hideHandoffCard').catch(() => undefined);
    await this.registry.applyBadge(tab.id!);
    const after = await api.tabs.get(tab.id!).catch(() => tab);
    return {
      tabId: tab.id,
      completed: outcome.completed,
      action: outcome.action,
      url: tabUrl(after),
      title: after.title ?? '',
    };
  }

  private async demonstrate(session: string, params: Params) {
    const action = (str(params, 'action') ?? 'record').toLowerCase();
    if (action === 'status') {
      return { demonstrations: listActiveDemonstrations() };
    }
    if (action === 'finish' || action === 'stop' || action === 'cancel') {
      const explicitId = num(params, 'tabId');
      const tab =
        explicitId !== undefined && isTabWaitingHandoff(explicitId)
          ? await api.tabs.get(explicitId).catch(() => undefined)
          : await this.registry.resolveTab(session, explicitId);
      if (!tab?.id) throw new BridgeError('no_tab', 'Target tab for demonstration does not exist.');
      const stopped = await callFrame<{ stopped: boolean; steps: Array<{ op: string; params: Record<string, unknown> }> }>(
        tab,
        0,
        'stopDemoRecorder',
      ).catch(() => ({ stopped: true, steps: [] }));
      const resolved = resolveDemonstrationWait(
        { tabId: tab.id },
        action === 'cancel' ? 'cancel' : 'finish',
        stopped.steps,
      );
      await this.registry.applyBadge(tab.id);
      return {
        tabId: tab.id,
        url: tabUrl(tab),
        completed: action !== 'cancel',
        action: action === 'cancel' ? 'cancel' : 'finish',
        steps: resolved?.steps ?? stopped.steps,
      };
    }

    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.demonstrate');
    const instruction =
      str(params, 'instruction') ??
      'Demonstrate the workflow on this page, then click Finish & Save.';
    const timeoutMs = Math.max(1_000, Math.min(num(params, 'timeoutMs') ?? 300_000, 600_000));
    if (bool(params, 'bringToFront') !== false) {
      await api.tabs.update(tab.id!, { active: true }).catch(() => undefined);
    }

    const origin = (() => {
      try {
        return new URL(tabUrl(tab)).origin;
      } catch {
        return tabUrl(tab);
      }
    })();
    const loc = resolveLocale(settings().locale);
    const finishLabel = loc.startsWith('zh') ? '完成并保存' : loc === 'ja' ? '完了して保存' : 'Finish & Save';
    const cancelLabel = loc.startsWith('zh') ? '取消' : loc === 'ja' ? 'キャンセル' : 'Cancel';
    const _unusedI18n = extMessages;
    void _unusedI18n;

    const { id, promise } = startDemonstrationWait(tab.id!, session, origin, instruction, timeoutMs, false, () => {
      void this.registry.applyBadge(tab.id!);
      this.registry.onChange();
    });
    await callFrame(tab, 0, 'startDemoRecorder', [{ id, instruction, finishLabel, cancelLabel }]);
    if (action === 'start') {
      void promise.then(async () => {
        await callFrame(tab, 0, 'stopDemoRecorder').catch(() => undefined);
        await this.registry.applyBadge(tab.id!);
      });
      return { tabId: tab.id, id, started: true };
    }
    const outcome = await promise;
    await callFrame(tab, 0, 'stopDemoRecorder').catch(() => undefined);
    await this.registry.applyBadge(tab.id!);
    const after = await api.tabs.get(tab.id!).catch(() => tab);
    return {
      tabId: tab.id,
      url: tabUrl(after),
      title: after.title ?? '',
      completed: outcome.completed,
      action: outcome.action,
      steps: outcome.steps,
    };
  }

  private async network(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const action = (str(params, 'action') ?? 'status').toLowerCase();
    if (action === 'start') {
      const started = startNetworkCapture(tab.id!, {
        maxEntries: num(params, 'maxEntries'),
        urlInclude: str(params, 'urlInclude'),
        clear: bool(params, 'clear') !== false,
      });
      return { tabId: tab.id, ...started };
    }
    if (action === 'stop') {
      return {
        tabId: tab.id,
        ...readNetworkCapture(tab.id!, {
          stop: true,
          onlyFailures: bool(params, 'onlyFailures') === true,
          limit: num(params, 'limit'),
        }),
      };
    }
    if (action === 'clear') {
      return { tabId: tab.id, ...readNetworkCapture(tab.id!, { clear: true, limit: 1 }), exchanges: [] };
    }
    return {
      tabId: tab.id,
      ...readNetworkCapture(tab.id!, {
        onlyFailures: bool(params, 'onlyFailures') === true,
        limit: num(params, 'limit'),
      }),
    };
  }

  private async console(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const action = (str(params, 'action') ?? 'read').toLowerCase();
    if (action === 'clear') {
      const cleared = await readPageConsole(tab, { clearOnly: true });
      return { tabId: tab.id, cleared: cleared.cleared ?? 0 };
    }
    const out = await readPageConsole(tab, {
      level: str(params, 'level') ?? 'all',
      limit: num(params, 'limit') ?? 100,
      clear: bool(params, 'clear') === true,
    });
    return { tabId: tab.id, ...out };
  }

  private async webmcpList(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const tools = await listWebMcpTools(tab);
    return {
      tabId: tab.id,
      mode: this.registry.effectiveMode(tab.id!),
      tools,
    };
  }

  private async webmcpCall(session: string, params: Params) {
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    const toolName = str(params, 'name', true)!;
    const args =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    const requireReadOnly =
      bool(params, 'readOnly') === true || this.registry.effectiveMode(tab.id!) === 'read';
    const submit = params.submit === undefined ? undefined : bool(params, 'submit');
    const outcome = await invokeWebMcpTool(tab, toolName, args, requireReadOnly, submit);
    return { tabId: tab.id, ...(outcome as Record<string, unknown>) };
  }

  private async evaluate(session: string, params: Params) {
    if (!settings().allowEvaluate) {
      throw new BridgeError('disabled', 'Page script evaluation is disabled. The user can enable "Allow agents to run page scripts" in the Browser Bridge popup.');
    }
    const tab = await this.registry.resolveTab(session, num(params, 'tabId'));
    this.registry.requireTabWrite(tab.id!, 'page.evaluate');
    const source = str(params, 'expression', true)!;
    const expression = bool(params, 'invoke')
      ? `(async () => { const value = (0, eval)(${JSON.stringify(source)}); return typeof value === "function" ? await value(${JSON.stringify(params.arg ?? null)}) : value; })()`
      : source;
    assertScriptable(tab);
    let value: unknown;
    if (await useTrustedInput(tab, 0)) {
      try {
        value = await cdp.evaluate(tab.id!, expression, num(params, 'timeoutMs') ?? 30_000);
      } catch (error) {
        throw new BridgeError('page_error', error instanceof Error ? error.message : String(error));
      }
    } else {
      const results = await api.scripting.executeScript({
        target: { tabId: tab.id!, frameIds: [0] },
        world: 'MAIN',
        func: async (code: string) => {
          try {
            const result = await (0, eval)(code);
            return { ok: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
          } catch (error) {
            return { err: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
          }
        },
        args: [expression],
      } as chrome.scripting.ScriptInjection<[string], { ok?: unknown; err?: string }>);
      const outcome = results?.[0]?.result as { ok?: unknown; err?: string } | undefined;
      if (!outcome) throw new BridgeError('page_error', 'No result (the page may block script evaluation).');
      if (outcome.err) throw new BridgeError('page_error', outcome.err);
      value = outcome.ok;
    }
    const json = JSON.stringify(value ?? null);
    if (json.length > 1_000_000) throw new BridgeError('result_too_large', 'Evaluation result exceeds 1000000 characters. Use a typed read or request API for larger content.');
    return { tabId: tab.id, result: json };
  }
}
