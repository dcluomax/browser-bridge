import { api, detectBrowser } from '../shared/api.ts';
import { extMessages, resolveLocale } from '../shared/i18n.ts';
import type { SavedScreenshotMessage } from '../shared/protocol.ts';
import { buildAgentPrompt, isShareableUrl } from '../popup/prompt.ts';
import * as cdp from './cdp.ts';
import type { NativeConnection } from './native.ts';
import { captureScreenshot, tabUrl } from './page.ts';
import { getInstanceId, settings } from './settings.ts';
import type { TabRegistry } from './tabs.ts';

function bgMessages() {
  const sysLang = typeof api.i18n?.getUILanguage === 'function' ? api.i18n.getUILanguage() : undefined;
  return extMessages(resolveLocale(settings().locale, sysLang));
}

const MENU_ROOT = 'bb:root';
const MENU_SHARE_RO_COPY = 'bb:share-ro-copy';
const MENU_SHARE_RW_COPY = 'bb:share-rw-copy';
const MENU_SELECTION_COPY = 'bb:selection-copy';
const MENU_LINK_COPY = 'bb:link-copy';
const MENU_SWITCH_MODE = 'bb:switch-mode';
const MENU_STOP_SHARE = 'bb:stop-share';
const MENU_SHOT_VIEWPORT = 'bb:shot-viewport';
const MENU_SHOT_FULLPAGE = 'bb:shot-fullpage';

let menuMutex: Promise<boolean> | null = null;
let lastMenuError = '';
let saveSeq = 1;
const pendingSaves = new Map<string, (msg: SavedScreenshotMessage) => void>();

export function contextMenuStatus(): { available: boolean; error: string } {
  return {
    available: Boolean(api.contextMenus),
    error: lastMenuError,
  };
}

export function onSavedScreenshot(msg: SavedScreenshotMessage): void {
  const resolver = pendingSaves.get(msg.id);
  if (resolver) {
    pendingSaves.delete(msg.id);
    resolver(msg);
  }
}

function createItemAsync(props: chrome.contextMenus.CreateProperties): Promise<string> {
  return new Promise((resolve) => {
    try {
      api.contextMenus.create(props, () => {
        const err = api.runtime.lastError?.message ?? '';
        resolve(err);
      });
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error));
    }
  });
}

function rootExistsAsync(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!api.contextMenus) {
      resolve(false);
      return;
    }
    try {
      api.contextMenus.update(MENU_ROOT, { title: 'Browser Bridge' }, () => {
        const err = api.runtime.lastError?.message;
        resolve(!err);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Rebuilds the Browser Bridge context menu cleanly.
 * Serialized so MV3 onInstalled and ensureContextMenus never interleave removeAll/create!
 */
export function rebuildContextMenus(): Promise<boolean> {
  if (menuMutex) return menuMutex;
  menuMutex = (async () => {
    if (!api.contextMenus) {
      lastMenuError = 'contextMenus permission is not active yet (click Reload once on edge://extensions).';
      return false;
    }
    await new Promise<void>((resolve) => {
      try {
        api.contextMenus.removeAll(() => {
          void api.runtime.lastError;
          resolve();
        });
      } catch {
        resolve();
      }
    });

    const allContexts: [`${chrome.contextMenus.ContextType}`, ...`${chrome.contextMenus.ContextType}`[]] = [
      'page',
      'frame',
      'selection',
      'link',
      'image',
    ];

    const t = bgMessages();
    const items: chrome.contextMenus.CreateProperties[] = [
      { id: MENU_ROOT, title: 'Browser Bridge', contexts: allContexts },
      { id: MENU_SHARE_RO_COPY, parentId: MENU_ROOT, title: t.menuShareRoCopy, contexts: allContexts },
      { id: MENU_SHARE_RW_COPY, parentId: MENU_ROOT, title: t.menuShareRwCopy, contexts: allContexts },
      { id: MENU_SELECTION_COPY, parentId: MENU_ROOT, title: t.menuSelectionCopy, contexts: ['selection'] },
      { id: MENU_LINK_COPY, parentId: MENU_ROOT, title: t.menuLinkCopy, contexts: ['link'] },
      { id: 'bb:sep-1', parentId: MENU_ROOT, type: 'separator', contexts: allContexts },
      { id: MENU_SWITCH_MODE, parentId: MENU_ROOT, title: t.menuEnableRoOnly, contexts: allContexts },
      { id: MENU_STOP_SHARE, parentId: MENU_ROOT, title: t.menuStopShare, contexts: allContexts },
      { id: 'bb:sep-2', parentId: MENU_ROOT, type: 'separator', contexts: allContexts },
      { id: MENU_SHOT_VIEWPORT, parentId: MENU_ROOT, title: t.menuShotViewport, contexts: allContexts },
      { id: MENU_SHOT_FULLPAGE, parentId: MENU_ROOT, title: t.menuShotFullPage, contexts: allContexts },
    ];

    const errors: string[] = [];
    for (const item of items) {
      const err = await createItemAsync(item);
      if (err && !/duplicate id/i.test(err)) errors.push(err);
    }
    lastMenuError = errors.join('; ');
    return errors.length === 0;
  })().finally(() => {
    menuMutex = null;
  });
  return menuMutex;
}

/** Ensures menus exist on Service Worker wake-up WITHOUT wiping existing menus via removeAll. */
export async function ensureContextMenus(): Promise<boolean> {
  if (!api.contextMenus) {
    lastMenuError = 'contextMenus permission is not active yet (click Reload once on edge://extensions).';
    return false;
  }
  if (await rootExistsAsync()) {
    lastMenuError = '';
    return true;
  }
  return await rebuildContextMenus();
}

export function syncContextMenuForTab(registry: TabRegistry, tabId: number | undefined): void {
  if (!api.contextMenus || tabId === undefined) return;
  const t = bgMessages();
  const grant = registry.grants.get(tabId);
  const mode = grant ? registry.effectiveMode(tabId) : null;
  const switchTitle = !grant
    ? t.menuEnableRoOnly
    : mode === 'read'
      ? t.menuSwitchToRw
      : t.menuSwitchToRo;
  try {
    api.contextMenus.update(MENU_SWITCH_MODE, { title: switchTitle }, () => { void api.runtime.lastError; });
    api.contextMenus.update(MENU_STOP_SHARE, { enabled: Boolean(grant) }, () => { void api.runtime.lastError; });
  } catch {
    // ignore before menus exist
  }
}

async function copyAndToastInTab(tabId: number, copyValue: string | null, toastMessage: string, isError = false): Promise<void> {
  await api.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      func: async (textToCopy: string | null, message: string, errorStyle: boolean) => {
        if (textToCopy !== null) {
          let copied = false;
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(textToCopy);
              copied = true;
            }
          } catch {
            copied = false;
          }
          if (!copied) {
            const ta = document.createElement('textarea');
            ta.value = textToCopy;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;top:0;left:0';
            (document.body ?? document.documentElement).appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
        }

        const existing = document.getElementById('__bb_toast_host');
        existing?.remove();
        const host = document.createElement('div');
        host.id = '__bb_toast_host';
        host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:none';
        const shadow = host.attachShadow({ mode: 'closed' });
        const pill = document.createElement('div');
        pill.textContent = message;
        pill.style.cssText = [
          'font:600 12.5px/1.4 "Segoe UI","Microsoft YaHei",system-ui,sans-serif',
          'padding:9px 14px',
          'border-radius:999px',
          errorStyle ? 'background:#8e2522;color:#fff' : 'background:#141619;color:#fff',
          'box-shadow:0 8px 24px rgba(0,0,0,0.22)',
          'border:1px solid rgba(255,255,255,0.14)',
          'max-width:380px',
          'white-space:nowrap',
          'overflow:hidden',
          'text-overflow:ellipsis',
        ].join(';');
        shadow.appendChild(pill);
        (document.body ?? document.documentElement).appendChild(host);
        setTimeout(() => host.remove(), 2000);
      },
      args: [copyValue, toastMessage, isError],
    })
    .catch(() => undefined);
}

async function saveViaHost(
  native: NativeConnection,
  title: string,
  fullPage: boolean,
  data: string,
): Promise<SavedScreenshotMessage> {
  native.ensureConnected();
  const id = `save-${saveSeq++}`;
  return await new Promise<SavedScreenshotMessage>((resolve) => {
    const timer = setTimeout(() => {
      pendingSaves.delete(id);
      resolve({ type: 'savedScreenshot', id, ok: false, error: bgMessages().toastHostTimeout });
    }, 25_000);
    pendingSaves.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    native.post({ type: 'saveScreenshot', id, title, fullPage, data });
  });
}

export async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
  registry: TabRegistry,
  native: NativeConnection,
  ensureReady: () => Promise<void>,
  releaseDebugTab?: (tabId: number) => Promise<void>,
): Promise<void> {
  await ensureReady();
  if (!tab || tab.id === undefined) return;
  const tabId = tab.id;
  const url = tabUrl(tab);
  if (!isShareableUrl(url)) return;

  const browser = await detectBrowser();
  const t = bgMessages();

  switch (info.menuItemId) {
    case MENU_SHARE_RO_COPY:
    case MENU_SHARE_RW_COPY:
    case MENU_SELECTION_COPY:
    case MENU_LINK_COPY: {
      const targetMode: 'read' | 'write' = info.menuItemId === MENU_SHARE_RW_COPY ? 'write' : 'read';
      registry.grant(tabId, 'user', null, url, targetMode);
      syncContextMenuForTab(registry, tabId);
      const effective = registry.effectiveMode(tabId);
      const focus =
        info.menuItemId === MENU_SELECTION_COPY
          ? info.selectionText
          : info.menuItemId === MENU_LINK_COPY
            ? info.linkUrl
            : undefined;
      const prompt = buildAgentPrompt({
        tabId,
        url,
        title: tab.title,
        browser: browser.kind,
        instanceId: getInstanceId(),
        label: settings().label || undefined,
        agentGuide: native.agentGuide,
        mode: effective,
        focus,
      });
      await copyAndToastInTab(
        tabId,
        prompt,
        effective === 'read' ? t.toastSharedRoCopied : t.toastSharedRwCopied,
      );
      return;
    }

    case MENU_SWITCH_MODE: {
      const existing = registry.grants.get(tabId);
      if (!existing) {
        registry.grant(tabId, 'user', null, url, 'read');
        syncContextMenuForTab(registry, tabId);
        await copyAndToastInTab(tabId, null, t.toastEnabledRo);
      } else {
        const nextMode = existing.mode === 'read' ? 'write' : 'read';
        if (nextMode === 'read') await releaseDebugTab?.(tabId);
        registry.setMode(tabId, nextMode);
        syncContextMenuForTab(registry, tabId);
        await copyAndToastInTab(
          tabId,
          null,
          nextMode === 'read' ? t.toastSwitchedRo : t.toastSwitchedRw,
        );
      }
      return;
    }

    case MENU_STOP_SHARE: {
      if (registry.grants.has(tabId)) {
        await releaseDebugTab?.(tabId);
        registry.revoke(tabId);
        await cdp.detach(tabId);
        syncContextMenuForTab(registry, tabId);
        await copyAndToastInTab(tabId, null, t.toastStoppedShare);
      }
      return;
    }

    case MENU_SHOT_VIEWPORT:
    case MENU_SHOT_FULLPAGE: {
      const fullPage = info.menuItemId === MENU_SHOT_FULLPAGE;
      if (fullPage) {
        await copyAndToastInTab(tabId, null, t.toastCapturingFull);
      }
      try {
        const freshTab = (await api.tabs.get(tabId).catch(() => undefined)) ?? tab;
        const shot = await captureScreenshot(freshTab, { format: 'png', maxWidth: 4096, fullPage });
        const saved = await saveViaHost(native, freshTab.title || 'page', fullPage, shot.data);
        if (saved.ok) {
          await copyAndToastInTab(tabId, null, t.toastSavedDownloads(saved.fileName ?? 'screenshot.png'));
        } else {
          await copyAndToastInTab(tabId, null, t.toastSaveFailed(saved.error ?? 'error'), true);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await copyAndToastInTab(tabId, null, t.toastShotFailed(msg), true);
      }
      return;
    }

    default:
      return;
  }
}
