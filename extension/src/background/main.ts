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
import { tabUrl } from './page.ts';
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
  currentTab: {
    id: number;
    title: string;
    url: string;
    shared: boolean;
    mode: AccessMode;
    access: string;
    scriptable: boolean;
  } | null;
  tabs: Array<{ id: number; title: string; url: string; access: string; mode: AccessMode }>;
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

async function handlePopup(message: {
  type: string;
  tabId?: number;
  share?: boolean;
  mode?: AccessMode;
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
  if (sender.id !== api.runtime.id || typeof message?.type !== 'string' || !message.type.startsWith('popup:')) return false;
  handlePopup(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

api.tabs.onRemoved.addListener((tabId) => {
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
  }
});

void api.alarms.create('browser-bridge-keepalive', { periodInMinutes: 1 });
void actionApi.setBadgeBackgroundColor({ color: '#2563eb' });
void ensureContextMenus();
void ensureReady().then(() => native.ensureConnected());
