import { actionApi, api, detectBrowser, isChromium } from '../shared/api.ts';
import { BridgeError, PROTOCOL_VERSION, type HelloMessage, type HostToExtension, type RequestMessage } from '../shared/protocol.ts';
import * as cdp from './cdp.ts';
import { Commands } from './commands.ts';
import {
  contextMenuStatus,
  ensureContextMenus,
  handleContextMenuClick,
  onSavedScreenshot,
  rebuildContextMenus,
  syncContextMenuForTab,
} from './context_menu.ts';
import { NativeConnection } from './native.ts';
import {
  cancelTabInteractions,
  listActiveDemonstrations,
  listActiveHandoffs,
  resolveDemonstrationWait,
  resolveHandoffWait,
  startDemonstrationWait,
  updateDemonstrationProgress,
  type DemonstrationSummary,
  type HandoffSummary,
  type RecordedRoutineStep,
} from './handoff.ts';
import { dropTabNetworkCapture } from './network.ts';
import { callFrame, tabUrl } from './page.ts';
import { resolveLocale } from '../shared/i18n.ts';
import { isShareableUrl } from '../popup/prompt.ts';
import { getInstanceId, loadSettings, settings, updateSettings, type Settings } from './settings.ts';
import { TabRegistry, type AccessMode } from './tabs.ts';

const registry = new TabRegistry();
const commands = new Commands(registry);
let ready: Promise<void> | undefined;
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

registry.onChange = () => {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    native.post({ type: 'event', event: 'tabs.changed' });
  }, 50);
};

async function buildHello(): Promise<HelloMessage> {
  await ensureReady();
  const browser = await detectBrowser();
  return {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    browser: browser.kind,
    browserVersion: browser.version,
    extensionVersion: api.runtime.getManifest().version,
    instanceId: getInstanceId(),
    label: settings().label,
  };
}

async function releaseTabs(tabIds: number[]): Promise<void> {
  await Promise.all(tabIds.map((id) => cdp.detach(id)));
  if (registry.sessions.size === 0) await cdp.detachAll();
}

async function handleRequest(message: RequestMessage): Promise<void> {
  try {
    if (!registry.sessions.has(message.session)) registry.openSession(message.session);
    const result = await commands.run(message.session, message.method, message.params ?? {});
    native.post({ type: 'response', id: message.id, ok: true, result });
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : 'internal_error';
    const text = error instanceof Error ? error.message : String(error);
    native.post({ type: 'response', id: message.id, ok: false, error: { code, message: text } });
  }
}

function onHostMessage(message: HostToExtension): void {
  switch (message?.type) {
    case 'session':
      if (message.event === 'open') registry.openSession(message.session, message.client);
      else void releaseTabs(registry.closeSession(message.session));
      break;
    case 'request':
      void handleRequest(message);
      break;
    case 'savedScreenshot':
      onSavedScreenshot(message);
      break;
    default:
      break;
  }
}

const native = new NativeConnection(onHostMessage, () => void releaseTabs(registry.closeAllSessions()), buildHello);

function ensureReady(): Promise<void> {
  ready ??= (async () => {
    await loadSettings();
    await registry.restore();
  })();
  return ready;
}

// ---------------------------------------------------------------------------------------------
// Popup API
// ---------------------------------------------------------------------------------------------

interface PopupState {
  status: string;
  error: string;
  hostVersion: string;
  pipeName: string;
  agentGuide: string;
  browser: string;
  instanceId: string;
  extensionVersion: string;
  contextMenuReady: boolean;
  contextMenuError: string;
  settings: Settings;
  trustedInputSupported: boolean;
  sessions: Array<{ id: string; name: string }>;
  handoffs: HandoffSummary[];
  demonstrations: DemonstrationSummary[];
  currentTab: {
    id: number;
    title: string;
    url: string;
    shared: boolean;
    mode: AccessMode;
    access: string;
    scriptable: boolean;
  } | null;
  tabs: Array<{ id: number; title: string; url: string; access: string; mode: AccessMode; name?: string; group?: string; waitingHandoff?: boolean }>;
}

function isTabScriptable(tab: chrome.tabs.Tab): boolean {
  return isShareableUrl(tabUrl(tab));
}

async function popupState(): Promise<PopupState> {
  await ensureReady();
  const browser = await detectBrowser();
  const menuState = contextMenuStatus();
  const [active] = await api.tabs.query({ active: true, currentWindow: true });
  const tabs: PopupState['tabs'] = [];
  for (const grant of registry.grants.values()) {
    const tab = await api.tabs.get(grant.tabId).catch(() => undefined);
    if (!tab) continue;
    const owner = grant.owner && registry.sessions.has(grant.owner) ? `in use by ${registry.sessions.get(grant.owner)!.name}` : grant.source === 'user' ? 'shared' : 'opened by agent';
    tabs.push({
      id: grant.tabId,
      title: tab.title ?? '',
      url: tab.url ?? '',
      access: owner,
      mode: registry.effectiveMode(grant.tabId),
      ...(grant.name ? { name: grant.name } : {}),
      ...(grant.groupTitle ? { group: grant.groupTitle } : {}),
      waitingHandoff: listActiveHandoffs().some((h) => h.tabId === grant.tabId),
    });
  }
  return {
    status: native.status,
    error: native.lastError,
    hostVersion: native.hostVersion,
    pipeName: native.pipeName,
    agentGuide: native.agentGuide,
    browser: browser.kind,
    instanceId: getInstanceId(),
    extensionVersion: api.runtime.getManifest().version,
    contextMenuReady: menuState.available && !menuState.error,
    contextMenuError: menuState.error,
    settings: { ...settings() },
    trustedInputSupported: cdp.trustedInputSupported(),
    sessions: [...registry.sessions.values()].map((s) => ({ id: s.id, name: s.name })),
    handoffs: listActiveHandoffs(),
    demonstrations: listActiveDemonstrations(),
    currentTab: active?.id !== undefined
      ? {
          id: active.id,
          title: active.title ?? '',
          url: tabUrl(active),
          shared: registry.grants.has(active.id),
          mode: registry.effectiveMode(active.id),
          access: tabs.find((t) => t.id === active.id)?.access ?? '',
          scriptable: isTabScriptable(active),
        }
      : null,
    tabs,
  };
}

const popupRoutineNames = new Map<number, string>();

async function handlePopup(message: {
  type: string;
  tabId?: number;
  share?: boolean;
  mode?: AccessMode;
  action?: 'continue' | 'cancel' | 'finish';
  routineName?: string;
  url?: string;
  patch?: Partial<Settings>;
}): Promise<unknown> {
  await ensureReady();
  switch (message.type) {
    case 'popup:state':
      return popupState();
    case 'popup:share':
      if (typeof message.tabId !== 'number') throw new Error('tabId required');
      if (message.share) {
        const sharedTab = await api.tabs.get(message.tabId).catch(() => undefined);
        registry.grant(message.tabId, 'user', null, sharedTab?.url ?? sharedTab?.pendingUrl, message.mode ?? 'read');
      } else {
        cancelTabInteractions(message.tabId);
        dropTabNetworkCapture(message.tabId);
        registry.revoke(message.tabId);
        await cdp.detach(message.tabId);
      }
      syncContextMenuForTab(registry, message.tabId);
      return popupState();
    case 'popup:mode':
      if (typeof message.tabId !== 'number' || (message.mode !== 'read' && message.mode !== 'write')) {
        throw new Error('tabId and mode (read|write) required');
      }
      registry.setMode(message.tabId, message.mode);
      syncContextMenuForTab(registry, message.tabId);
      return popupState();
    case 'popup:handoffResolve': {
      if (typeof message.tabId !== 'number') throw new Error('tabId required');
      const act = message.action === 'cancel' ? 'cancel' : 'continue';
      resolveHandoffWait({ tabId: message.tabId }, act);
      const t = await api.tabs.get(message.tabId).catch(() => undefined);
      if (t) await callFrame(t, 0, 'hideHandoffCard').catch(() => undefined);
      await registry.applyBadge(message.tabId);
      return popupState();
    }
    case 'popup:startDemo': {
      if (typeof message.tabId !== 'number') throw new Error('tabId required');
      const tab = await api.tabs.get(message.tabId).catch(() => undefined);
      if (!tab) throw new Error('Tab not found');
      const rName =
        message.routineName?.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) ||
        `taught_flow_${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
      popupRoutineNames.set(message.tabId, rName);
      const loc = resolveLocale(settings().locale);
      const finishLabel = loc.startsWith('zh') ? '完成并保存' : loc === 'ja' ? '完了して保存' : 'Finish & Save';
      const cancelLabel = loc.startsWith('zh') ? '取消' : loc === 'ja' ? 'キャンセル' : 'Cancel';
      const instruction = loc.startsWith('zh')
        ? `正在录制流程 "${rName}"：在页面操作后点击「完成并保存」`
        : `Recording routine "${rName}": act on the page, then click Finish & Save.`;
      const { id, promise } = startDemonstrationWait(message.tabId, 'popup', tabUrl(tab), instruction, 300_000, true, () => {
        void registry.applyBadge(message.tabId!);
        registry.onChange();
      });
      await callFrame(tab, 0, 'startDemoRecorder', [{ id, instruction, finishLabel, cancelLabel }]);
      void promise.then((outcome) => {
        const savedName = popupRoutineNames.get(message.tabId!) ?? rName;
        popupRoutineNames.delete(message.tabId!);
        if (outcome.completed && outcome.steps.length > 0) {
          native.post({
            type: 'saveDemonstratedRoutine',
            url: tabUrl(tab),
            name: savedName,
            description: `User-demonstrated workflow (${outcome.steps.length} step${outcome.steps.length === 1 ? '' : 's'}).`,
            steps: outcome.steps,
          });
        }
      });
      return popupState();
    }
    case 'popup:finishDemo': {
      if (typeof message.tabId !== 'number') throw new Error('tabId required');
      const tab = await api.tabs.get(message.tabId).catch(() => undefined);
      const stopped = tab
        ? await callFrame<{ stopped: boolean; steps: RecordedRoutineStep[] }>(tab, 0, 'stopDemoRecorder').catch(() => ({
            stopped: true,
            steps: [] as RecordedRoutineStep[],
          }))
        : { stopped: true, steps: [] as RecordedRoutineStep[] };
      resolveDemonstrationWait(
        { tabId: message.tabId },
        message.action === 'cancel' ? 'cancel' : 'finish',
        stopped.steps,
      );
      await registry.applyBadge(message.tabId);
      return popupState();
    }
    case 'popup:activate':
      if (typeof message.tabId !== 'number') throw new Error('tabId required');
      {
        const target = await api.tabs.update(message.tabId, { active: true }).catch(() => undefined);
        if (target?.windowId !== undefined) {
          await api.windows.update(target.windowId, { focused: true }).catch(() => undefined);
        }
      }
      return popupState();
    case 'popup:settings': {
      const before = settings();
      const after = await updateSettings(message.patch ?? {});
      if (before.trustedInput && !after.trustedInput) await cdp.detachAll();
      if (before.readOnlyMode !== after.readOnlyMode) await registry.refreshAllBadges();
      if (before.locale !== after.locale) {
        await rebuildContextMenus();
        const [active] = await api.tabs.query({ active: true, currentWindow: true });
        syncContextMenuForTab(registry, active?.id);
      }
      if (before.label !== after.label) native.post(await buildHello());
      return popupState();
    }
    case 'popup:rebuildMenus':
      await rebuildContextMenus();
      return popupState();
    case 'popup:reconnect':
      native.reconnect();
      return popupState();
    default:
      throw new Error(`Unknown popup message ${message.type}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Event wiring (must be registered synchronously at top level for MV3 service workers)
// ---------------------------------------------------------------------------------------------

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || typeof message?.type !== 'string') return false;
  if (message.type === 'content:handoff' && typeof sender.tab?.id === 'number') {
    const act = message.action === 'cancel' ? 'cancel' : 'continue';
    resolveHandoffWait({ tabId: sender.tab.id, id: typeof message.id === 'string' ? message.id : undefined }, act);
    void registry.applyBadge(sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'content:demoProgress' && typeof sender.tab?.id === 'number') {
    if (Array.isArray(message.steps)) {
      updateDemonstrationProgress(
        sender.tab.id,
        typeof message.id === 'string' ? message.id : undefined,
        message.steps as RecordedRoutineStep[],
      );
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'content:demoFinish' && typeof sender.tab?.id === 'number') {
    const act = message.action === 'cancel' ? 'cancel' : 'finish';
    resolveDemonstrationWait(
      { tabId: sender.tab.id, id: typeof message.id === 'string' ? message.id : undefined },
      act,
      Array.isArray(message.steps) ? (message.steps as RecordedRoutineStep[]) : undefined,
    );
    void registry.applyBadge(sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }
  if (!message.type.startsWith('popup:')) return false;
  handlePopup(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

api.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return;
  const parentGrant = registry.grants.get(tab.openerTabId);
  if (!parentGrant || !parentGrant.owner || !registry.sessions.has(parentGrant.owner)) return;
  const childUrl = tabUrl(tab);
  if (childUrl && childUrl !== 'about:blank') {
    try {
      registry.assertNavigationAllowed(parentGrant.owner, tab.openerTabId, childUrl);
    } catch {
      void api.tabs.remove(tab.id).catch(() => undefined);
      return;
    }
  }
  registry.grant(tab.id, 'agent', parentGrant.owner, childUrl || undefined, parentGrant.mode, {
    groupTitle: parentGrant.groupTitle,
    allowedOrigins: parentGrant.allowedOrigins,
  });
  void registry.groupAgentTab(tab, parentGrant.groupTitle);
});

api.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || !details.url || details.url === 'about:blank') return;
  const grant = registry.grants.get(details.tabId);
  if (!grant) return;
  const owner = grant.owner && registry.sessions.has(grant.owner) ? grant.owner : '';
  try {
    registry.assertNavigationAllowed(owner, details.tabId, details.url);
  } catch {
    void api.tabs.update(details.tabId, { url: 'about:blank' }).catch(() => undefined);
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  cancelTabInteractions(tabId);
  dropTabNetworkCapture(tabId);
  registry.onTabRemoved(tabId);
  cdp.clearDismissed(tabId);
  void cdp.detach(tabId);
});

api.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  registry.onTabReplaced(addedTabId, removedTabId);
  cdp.clearDismissed(removedTabId);
  void cdp.detach(removedTabId);
});

api.tabs.onUpdated.addListener((tabId, info) => {
  if (registry.grants.has(tabId)) {
    if (info.status === 'loading') void registry.applyBadge(tabId);
    if (info.title !== undefined || info.url !== undefined || info.status === 'complete') registry.onChange();
  }
});

api.tabs.onActivated.addListener(({ tabId }) => {
  syncContextMenuForTab(registry, tabId);
  if (registry.grants.size > 0) registry.onChange();
});

if (!isChromium) {
  void (api.scripting as typeof chrome.scripting)
    .registerContentScripts([
      {
        id: 'bb-webmcp',
        matches: ['http://*/*', 'https://*/*', 'file://*/*'],
        js: ['webmcp.js'],
        runAt: 'document_start',
        world: 'MAIN',
      },
    ])
    .catch(() => undefined);
}

if (api.contextMenus) {
  api.contextMenus.onClicked.addListener((info, tab) => {
    void handleContextMenuClick(info, tab, registry, native, ensureReady);
  });
}

api.runtime.onStartup.addListener(() => {
  void rebuildContextMenus();
  void ensureReady().then(() => native.ensureConnected());
});

api.runtime.onInstalled.addListener(() => {
  void rebuildContextMenus();
  void ensureReady().then(() => native.ensureConnected());
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'browser-bridge-keepalive') {
    native.ensureConnected();
    void ensureContextMenus();
    void registry.sweepIdleAgentTabs(Date.now(), async (id) => {
      cancelTabInteractions(id);
      dropTabNetworkCapture(id);
      await cdp.detach(id);
    });
  }
});

void api.alarms.create('browser-bridge-keepalive', { periodInMinutes: 1 });
void actionApi.setBadgeBackgroundColor({ color: '#2563eb' });
void ensureContextMenus();
void ensureReady().then(() => native.ensureConnected());
