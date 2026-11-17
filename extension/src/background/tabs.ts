import { actionApi, api, isChromium } from '../shared/api.ts';
import { BridgeError } from '../shared/protocol.ts';
import { assertAllowedByLists, normalizeAllowedOrigins } from './allowlist.ts';
import { isTabWaitingHandoff } from './handoff.ts';
import { settings } from './settings.ts';

export type AccessMode = 'read' | 'write';

export interface Grant {
  tabId: number;
  /** Session that currently controls the tab; null when shared but unclaimed. */
  owner: string | null;
  source: 'agent' | 'user';
  /** Access level granted to agents on this tab ('read' = inspect/screenshot only, 'write' = full interaction). */
  mode?: AccessMode;
  grantedAt: number;
  lastUsedAt?: number;
  /** Optional persistent handle name (e.g. "work-mail"); exempts the tab from idle auto-close. */
  name?: string;
  /** Tab group title used on Chromium (defaults to "Agent"). */
  groupTitle?: string;
  /** Optional per-tab origin/domain allowlist. */
  allowedOrigins?: string[];
  /** Origin recorded when user shared the tab; used to safely restore across extension reloads. */
  origin?: string;
}

export interface SessionState {
  id: string;
  name: string;
  pid?: number;
  currentTabId?: number;
  allowedOrigins?: string[];
  openedAt: number;
}

const BADGE_WRITE_COLOR = '#2563eb';
const BADGE_READ_COLOR = '#059669';
const BADGE_RUN_COLOR = '#4f46e5';
const BADGE_WAIT_COLOR = '#d97706';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionStorage: chrome.storage.StorageArea | undefined = (api.storage as any).session;

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.origin && parsed.origin !== 'null' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tracks which tabs agents may use. Users share tabs from the toolbar popup; tabs an agent opens
 * are granted to it automatically. A tab is controlled by at most one session at a time.
 */
export class TabRegistry {
  readonly grants = new Map<number, Grant>();
  readonly sessions = new Map<string, SessionState>();
  private readonly activeCalls = new Map<number, number>();
  onChange: () => void = () => {};

  async restore(): Promise<void> {
    const candidates = new Map<number, Grant>();
    if (sessionStorage) {
      try {
        const stored = (await sessionStorage.get('grants')) as { grants?: Grant[] };
        for (const grant of stored.grants ?? []) candidates.set(grant.tabId, grant);
      } catch {
        // storage.session unavailable
      }
    }
    try {
      const persisted = (await api.storage.local.get('userGrants')) as { userGrants?: Grant[] };
      for (const grant of persisted.userGrants ?? []) {
        if (grant.source === 'user' && !candidates.has(grant.tabId)) candidates.set(grant.tabId, grant);
      }
    } catch {
      // storage.local unavailable
    }
    for (const grant of candidates.values()) {
      const tab = await api.tabs.get(grant.tabId).catch(() => undefined);
      if (!tab) continue;
      if (grant.source === 'user' && grant.origin && originOf(tab.url ?? tab.pendingUrl) !== grant.origin) continue;
      this.grants.set(grant.tabId, { ...grant, owner: null });
      void this.applyBadge(grant.tabId);
    }
    if (this.grants.size > 0) this.persist();
  }

  private persist(): void {
    this.onChange();
    const list = [...this.grants.values()];
    if (sessionStorage) {
      void sessionStorage.set({ grants: list }).catch(() => undefined);
    }
    const userGrants = list.filter((grant) => grant.source === 'user');
    void api.storage.local.set({ userGrants }).catch(() => undefined);
  }

  openSession(id: string, client?: { name?: string; pid?: number }): void {
    this.sessions.set(id, { id, name: client?.name ?? 'agent', pid: client?.pid, openedAt: Date.now() });
    this.onChange();
  }

  /** Releases tabs owned by the session; they stay shared so a later session can continue. */
  closeSession(id: string): number[] {
    const released: number[] = [];
    for (const grant of this.grants.values()) {
      if (grant.owner === id) {
        grant.owner = null;
        released.push(grant.tabId);
      }
    }
    this.sessions.delete(id);
    this.persist();
    return released;
  }

  closeAllSessions(): number[] {
    const released: number[] = [];
    for (const id of [...this.sessions.keys()]) released.push(...this.closeSession(id));
    return released;
  }

  grant(
    tabId: number,
    source: 'agent' | 'user',
    owner: string | null,
    url?: string,
    mode?: AccessMode,
    options?: { name?: string; groupTitle?: string; allowedOrigins?: string[] },
  ): void {
    const existing = this.grants.get(tabId);
    const origin = originOf(url) ?? existing?.origin;
    const resolvedMode: AccessMode = mode ?? existing?.mode ?? 'write';
    const now = Date.now();
    const cleanName = options?.name?.trim() || existing?.name;
    const groupTitle = options?.groupTitle?.trim() || existing?.groupTitle;
    const allowedOrigins =
      options?.allowedOrigins !== undefined
        ? normalizeAllowedOrigins(options.allowedOrigins)
        : existing?.allowedOrigins;
    if (cleanName) {
      for (const [otherId, otherGrant] of this.grants.entries()) {
        if (otherId !== tabId && otherGrant.name === cleanName) {
          delete otherGrant.name;
        }
      }
    }
    this.grants.set(tabId, {
      tabId,
      owner: owner ?? existing?.owner ?? null,
      source: source === 'user' || existing?.source === 'user' ? 'user' : 'agent',
      mode: resolvedMode,
      grantedAt: existing?.grantedAt ?? now,
      lastUsedAt: now,
      ...(cleanName ? { name: cleanName } : {}),
      ...(groupTitle ? { groupTitle } : {}),
      ...(allowedOrigins && allowedOrigins.length > 0 ? { allowedOrigins } : {}),
      ...(origin ? { origin } : {}),
    });
    void this.applyBadge(tabId);
    this.persist();
  }

  findNamedTab(session: string, name: string): Grant | undefined {
    const target = name.trim();
    if (!target) return undefined;
    for (const grant of this.grants.values()) {
      if (grant.name === target && this.canAccess(session, grant.tabId)) {
        return grant;
      }
    }
    return undefined;
  }

  touch(tabId: number): void {
    const g = this.grants.get(tabId);
    if (g) g.lastUsedAt = Date.now();
  }

  beginTabCall(tabId: number): void {
    this.touch(tabId);
    const prev = this.activeCalls.get(tabId) ?? 0;
    this.activeCalls.set(tabId, prev + 1);
    if (prev === 0) void this.applyBadge(tabId);
  }

  endTabCall(tabId: number): void {
    this.touch(tabId);
    const next = Math.max(0, (this.activeCalls.get(tabId) ?? 1) - 1);
    if (next === 0) {
      this.activeCalls.delete(tabId);
      void this.applyBadge(tabId);
    } else {
      this.activeCalls.set(tabId, next);
    }
  }

  isTabBusyRunning(tabId: number): boolean {
    return (this.activeCalls.get(tabId) ?? 0) > 0;
  }

  setSessionAllowlist(session: string, origins: unknown): string[] {
    const normalized = normalizeAllowedOrigins(origins);
    let state = this.sessions.get(session);
    if (!state) {
      this.openSession(session);
      state = this.sessions.get(session)!;
    }
    state.allowedOrigins = normalized.length > 0 ? normalized : undefined;
    return normalized;
  }

  setTabAllowlist(tabId: number, origins: unknown): string[] {
    const normalized = normalizeAllowedOrigins(origins);
    const grant = this.grants.get(tabId);
    if (grant) {
      grant.allowedOrigins = normalized.length > 0 ? normalized : undefined;
      this.persist();
    }
    return normalized;
  }

  effectiveAllowlist(session: string, tabId?: number): { sessionOrigins: string[]; tabOrigins: string[] } {
    return {
      sessionOrigins: this.sessions.get(session)?.allowedOrigins ?? [],
      tabOrigins: (tabId !== undefined ? this.grants.get(tabId)?.allowedOrigins : undefined) ?? [],
    };
  }

  assertNavigationAllowed(session: string, tabId: number | undefined, url: string): void {
    const { sessionOrigins, tabOrigins } = this.effectiveAllowlist(session, tabId);
    assertAllowedByLists(url, sessionOrigins, tabOrigins);
  }

  async groupAgentTab(tab: chrome.tabs.Tab, requestedTitle?: string): Promise<string | undefined> {
    if (!isChromium || tab.id === undefined || !settings().groupAgentTabs) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabsAny = api.tabs as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groupsApi = (api as any).tabGroups;
    if (typeof tabsAny?.group !== 'function' || !groupsApi) return undefined;
    const title = requestedTitle?.trim() || 'Agent';
    try {
      const existingGroups = (await groupsApi.query({ windowId: tab.windowId, title })) as Array<{ id: number; collapsed: boolean }>;
      let groupId: number;
      if (existingGroups && existingGroups.length > 0) {
        groupId = existingGroups[0].id;
        await tabsAny.group({ groupId, tabIds: [tab.id] });
      } else {
        groupId = await tabsAny.group({
          tabIds: [tab.id],
          ...(tab.windowId !== undefined ? { createProperties: { windowId: tab.windowId } } : {}),
        });
        await groupsApi.update(groupId, { title, color: 'blue', collapsed: !tab.active });
        return title;
      }
      if (!tab.active) {
        const activeTabs = await api.tabs.query({ windowId: tab.windowId, active: true }).catch(() => []);
        const activeInGroup = activeTabs.some((t) => (t as unknown as { groupId?: number }).groupId === groupId);
        if (!activeInGroup) {
          await groupsApi.update(groupId, { collapsed: true }).catch(() => undefined);
        }
      }
      return title;
    } catch {
      return undefined;
    }
  }

  async sweepIdleAgentTabs(now = Date.now(), onBeforeClose?: (tabId: number) => Promise<void>): Promise<number[]> {
    const minutes = settings().idleCloseMinutes;
    if (!minutes || minutes <= 0) return [];
    const maxIdleMs = minutes * 60_000;
    const closed: number[] = [];
    for (const grant of [...this.grants.values()]) {
      if (grant.source !== 'agent' || grant.name) continue;
      if (this.isTabBusyRunning(grant.tabId) || isTabWaitingHandoff(grant.tabId)) continue;
      const last = grant.lastUsedAt ?? grant.grantedAt;
      if (now - last < maxIdleMs) continue;
      const tab = await api.tabs.get(grant.tabId).catch(() => undefined);
      if (!tab || tab.active) continue;
      const siblings = await api.tabs.query(tab.windowId !== undefined ? { windowId: tab.windowId } : {}).catch(() => []);
      if (siblings.length <= 1) continue;
      if (onBeforeClose) await onBeforeClose(grant.tabId).catch(() => undefined);
      await api.tabs.remove(grant.tabId).catch(() => undefined);
      this.onTabRemoved(grant.tabId);
      closed.push(grant.tabId);
    }
    return closed;
  }

  setMode(tabId: number, mode: AccessMode): void {
    const existing = this.grants.get(tabId);
    if (!existing) return;
    existing.mode = mode;
    void this.applyBadge(tabId);
    this.persist();
  }

  effectiveMode(tabId: number): AccessMode {
    if (settings().readOnlyMode) return 'read';
    return this.grants.get(tabId)?.mode === 'read' ? 'read' : 'write';
  }

  requireGlobalWrite(operation: string): void {
    if (settings().readOnlyMode) {
      throw new BridgeError(
        'read_only',
        `Global read-only lock is active in Browser Bridge; "${operation}" is not permitted.`,
      );
    }
  }

  requireTabWrite(tabId: number, operation: string): void {
    this.requireGlobalWrite(operation);
    if (this.grants.get(tabId)?.mode === 'read') {
      throw new BridgeError(
        'read_only',
        `Tab ${tabId} is shared in read-only mode; "${operation}" is not permitted. Switch the tab to Read-Write in Browser Bridge if interaction is intended.`,
      );
    }
  }

  revoke(tabId: number): void {
    if (!this.grants.delete(tabId)) return;
    for (const session of this.sessions.values()) {
      if (session.currentTabId === tabId) session.currentTabId = undefined;
    }
    void actionApi.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    this.persist();
  }

  onTabRemoved(tabId: number): void {
    this.activeCalls.delete(tabId);
    if (this.grants.delete(tabId)) this.persist();
    for (const session of this.sessions.values()) {
      if (session.currentTabId === tabId) session.currentTabId = undefined;
    }
  }

  onTabReplaced(addedTabId: number, removedTabId: number): void {
    const existing = this.grants.get(removedTabId);
    if (!existing) return;
    const calls = this.activeCalls.get(removedTabId);
    this.activeCalls.delete(removedTabId);
    if (calls) this.activeCalls.set(addedTabId, calls);
    this.grants.delete(removedTabId);
    this.grants.set(addedTabId, { ...existing, tabId: addedTabId });
    for (const session of this.sessions.values()) {
      if (session.currentTabId === removedTabId) session.currentTabId = addedTabId;
    }
    void this.applyBadge(addedTabId);
    this.persist();
  }

  async applyBadge(tabId: number): Promise<void> {
    if (!this.grants.has(tabId)) return;
    let color = BADGE_WRITE_COLOR;
    let text = 'RW';
    if (isTabWaitingHandoff(tabId)) {
      color = BADGE_WAIT_COLOR;
      text = 'WAIT';
    } else if (this.isTabBusyRunning(tabId)) {
      color = BADGE_RUN_COLOR;
      text = 'RUN';
    } else if (this.effectiveMode(tabId) === 'read') {
      color = BADGE_READ_COLOR;
      text = 'RO';
    }
    try {
      await actionApi.setBadgeBackgroundColor({ tabId, color });
      await actionApi.setBadgeText({ tabId, text });
    } catch {
      // tab may have closed
    }
  }

  async refreshAllBadges(): Promise<void> {
    await Promise.all([...this.grants.keys()].map((id) => this.applyBadge(id)));
  }

  canAccess(session: string, tabId: number): boolean {
    const grant = this.grants.get(tabId);
    if (grant) return grant.owner === null || grant.owner === session || !this.sessions.has(grant.owner);
    return settings().accessAllTabs;
  }

  ownerLabel(session: string, tabId: number): string {
    const grant = this.grants.get(tabId);
    if (!grant) return 'not shared (all-tabs mode)';
    if (grant.owner === session) return 'yours';
    if (grant.owner === null || !this.sessions.has(grant.owner)) return grant.source === 'user' ? 'shared by user' : 'released';
    return 'other agent';
  }

  claim(session: string, tabId: number): void {
    const grant = this.grants.get(tabId);
    if (!grant) {
      // All-tabs mode: record the claim so the badge shows which tab is under agent control.
      this.grant(tabId, 'user', session);
    } else if (grant.owner !== session) {
      grant.owner = session;
      this.persist();
    }
    const state = this.sessions.get(session);
    if (state) state.currentTabId = tabId;
  }

  async accessibleTabs(session: string): Promise<chrome.tabs.Tab[]> {
    if (settings().accessAllTabs) return api.tabs.query({});
    const tabs: chrome.tabs.Tab[] = [];
    for (const grant of this.grants.values()) {
      if (!this.canAccess(session, grant.tabId)) continue;
      const tab = await api.tabs.get(grant.tabId).catch(() => undefined);
      if (tab) tabs.push(tab);
      else this.onTabRemoved(grant.tabId);
    }
    return tabs;
  }

  /** Shared metadata is visible while a user-shared tab is busy; control remains exclusive. */
  async sharedTabs(session: string): Promise<chrome.tabs.Tab[]> {
    const visible = (tabId: number) => {
      const grant = this.grants.get(tabId);
      return grant !== undefined && (grant.source === 'user' || this.canAccess(session, tabId));
    };
    const tabs: chrome.tabs.Tab[] = [];
    for (const tabId of [...this.grants.keys()]) {
      if (!visible(tabId)) continue;
      let tab: chrome.tabs.Tab;
      try {
        tab = await api.tabs.get(tabId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no tab with id|invalid tab id/i.test(message)) {
          this.onTabRemoved(tabId);
          continue;
        }
        throw new BridgeError('tabs_failed', `Could not read shared tab ${tabId}: ${message}`);
      }
      if (visible(tabId)) tabs.push(tab);
    }
    return tabs;
  }

  async requireTab(session: string, tabId: number): Promise<chrome.tabs.Tab> {
    const tab = await api.tabs.get(tabId).catch(() => undefined);
    if (!tab) throw new BridgeError('no_tab', `Tab ${tabId} does not exist. Call browser_tabs with action "list".`);
    if (!this.canAccess(session, tabId)) {
      throw new BridgeError('forbidden', `Tab ${tabId} is not shared with this agent${this.grants.get(tabId) ? ' (another agent controls it)' : ''}. Ask the user to share it from the Browser Bridge toolbar button, or open a new tab.`);
    }
    this.claim(session, tabId);
    return tab;
  }

  /** Resolves the tab a command should act on: explicit id, the session's current tab, or a sole candidate. */
  async resolveTab(session: string, tabId?: number | null): Promise<chrome.tabs.Tab> {
    if (typeof tabId === 'number') return this.requireTab(session, tabId);
    const state = this.sessions.get(session);
    if (state?.currentTabId !== undefined && this.canAccess(session, state.currentTabId)) {
      const tab = await api.tabs.get(state.currentTabId).catch(() => undefined);
      if (tab) return tab;
      state.currentTabId = undefined;
    }
    const all = [...this.grants.values()].filter((g) => this.canAccess(session, g.tabId));
    const owned = all.filter((g) => g.owner === session);
    const candidates = owned.length ? owned : all;
    if (candidates.length === 1) return this.requireTab(session, candidates[0].tabId);
    if (candidates.length > 1) {
      const [active] = await api.tabs.query({ active: true, lastFocusedWindow: true });
      const preferred = candidates.find((g) => g.tabId === active?.id) ?? candidates.sort((a, b) => b.grantedAt - a.grantedAt)[0];
      return this.requireTab(session, preferred.tabId);
    }
    if (settings().accessAllTabs) {
      const [active] = await api.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id !== undefined) return this.requireTab(session, active.id);
    }
    throw new BridgeError(
      'no_tab',
      'No tab is shared with this agent. Open one with browser_tabs (action "new") or browser_navigate, or ask the user to click the Browser Bridge toolbar button and choose "Share this tab".',
    );
  }
}
