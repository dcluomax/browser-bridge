import { api, isChromium } from '../shared/api.ts';
import { MODIFIER_BITS, parseKeyCombo, producesText, type KeyPress } from '../shared/keys.ts';
import { settings } from './settings.ts';

/**
 * Trusted input for Chromium through chrome.debugger (Chrome DevTools Protocol). Events produced
 * this way are indistinguishable from real user input for the page and carry user activation,
 * which DOM-dispatched events cannot. While attached, the browser shows a debugging banner.
 */

export interface OpenDialogInfo {
  type: string;
  message: string;
  defaultPrompt?: string;
  openedAt: number;
}

const attached = new Set<number>();
const failed = new Map<number, number>();
const dismissedTabs = new Set<number>();
const openDialogs = new Map<number, OpenDialogInfo>();

const debuggerApi: typeof chrome.debugger | undefined = isChromium ? api.debugger : undefined;

if (debuggerApi) {
  debuggerApi.onDetach.addListener((source, reason) => {
    if (source.tabId !== undefined) {
      attached.delete(source.tabId);
      openDialogs.delete(source.tabId);
    }
    if (reason === 'canceled_by_user') {
      // Fall back to DOM events on the dismissed tab without disabling trusted input globally.
      if (source.tabId !== undefined) dismissedTabs.add(source.tabId);
    }
  });
  debuggerApi.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    if (method === 'Page.javascriptDialogOpening') {
      const p = (params ?? {}) as { type?: string; message?: string; defaultPrompt?: string };
      openDialogs.set(source.tabId, {
        type: p.type ?? 'alert',
        message: p.message ?? '',
        defaultPrompt: p.defaultPrompt,
        openedAt: Date.now(),
      });
    } else if (method === 'Page.javascriptDialogClosed') {
      openDialogs.delete(source.tabId);
    }
  });
}

export function clearDismissed(tabId: number): void {
  dismissedTabs.delete(tabId);
}

export function trustedInputSupported(): boolean {
  return Boolean(debuggerApi);
}

/** Attaches when trusted input is enabled. Returns false (caller falls back to DOM events) otherwise. */
export async function ensureAttached(tabId: number): Promise<boolean> {
  if (!debuggerApi || !settings().trustedInput || dismissedTabs.has(tabId)) return false;
  if (attached.has(tabId)) return true;
  const lastFailure = failed.get(tabId);
  if (lastFailure && Date.now() - lastFailure < 30_000) return false;
  try {
    await debuggerApi.attach({ tabId }, '1.3');
    attached.add(tabId);
    failed.delete(tabId);
    await send(tabId, 'Page.enable', {}).catch(() => undefined);
    await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already attached/i.test(message)) {
      attached.add(tabId);
      return true;
    }
    failed.set(tabId, Date.now());
    return false;
  }
}

export async function detach(tabId: number): Promise<void> {
  if (!debuggerApi || !attached.has(tabId)) return;
  attached.delete(tabId);
  await debuggerApi.detach({ tabId }).catch(() => undefined);
}

export async function detachAll(): Promise<void> {
  await Promise.all([...attached].map((tabId) => detach(tabId)));
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

const COMMAND_TIMEOUT_MS = 10_000;

export async function send<T = unknown>(tabId: number, method: string, params: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
  if (!debuggerApi) throw new Error('chrome.debugger is unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DevTools command ${method} timed out`)), timeoutMs);
  });
  try {
    return (await Promise.race([debuggerApi.sendCommand({ tabId }, method, params), timeout])) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function modifierMaskFromNames(names: readonly string[] | undefined): number {
  let mask = 0;
  for (const name of names ?? []) {
    const mod = parseKeyCombo(`${name}+a`).modifiers[0];
    if (mod) mask |= MODIFIER_BITS[mod];
  }
  return mask;
}

export async function click(tabId: number, x: number, y: number, options: { button?: string; clickCount?: number; modifiers?: number } = {}): Promise<void> {
  const button = options.button === 'right' ? 'right' : options.button === 'middle' ? 'middle' : 'left';
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  const modifiers = options.modifiers ?? 0;
  const count = Math.max(1, Math.min(options.clickCount ?? 1, 3));
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers, button: 'none' });
  for (let i = 1; i <= count; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, modifiers, button, buttons, clickCount: i });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, modifiers, button, buttons: 0, clickCount: i });
  }
}

export async function hover(tabId: number, x: number, y: number): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}

export async function drag(tabId: number, fromX: number, fromY: number, toX: number, toY: number, steps = 10): Promise<void> {
  const count = Math.max(2, Math.min(steps, 60));
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY, button: 'none' });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= count; i++) {
    const x = fromX + ((toX - fromX) * i) / count;
    const y = fromY + ((toY - fromY) * i) / count;
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  }
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 });
}

async function keyEvent(tabId: number, type: string, def: KeyPress['def'], modifiers: number, text?: string): Promise<void> {
  await send(tabId, 'Input.dispatchKeyEvent', {
    type,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    location: def.location ?? 0,
    modifiers,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
}

export async function press(tabId: number, keyPress: KeyPress): Promise<void> {
  let mask = 0;
  for (const mod of keyPress.modifiers) {
    mask |= MODIFIER_BITS[mod];
    await keyEvent(tabId, 'rawKeyDown', parseKeyCombo(mod).def, mask);
  }
  const text = producesText(keyPress) ? keyPress.def.text : undefined;
  await keyEvent(tabId, text ? 'keyDown' : 'rawKeyDown', keyPress.def, mask, text);
  await keyEvent(tabId, 'keyUp', keyPress.def, mask);
  for (const mod of [...keyPress.modifiers].reverse()) {
    mask &= ~MODIFIER_BITS[mod];
    await keyEvent(tabId, 'keyUp', parseKeyCombo(mod).def, mask);
  }
}

export async function insertText(tabId: number, text: string): Promise<void> {
  await send(tabId, 'Input.insertText', { text });
}

export async function typeSlowly(tabId: number, text: string): Promise<void> {
  for (const ch of text) {
    await press(tabId, parseKeyCombo(ch === '\n' ? 'Enter' : ch));
  }
}

export async function evaluate(tabId: number, expression: string, timeoutMs = 30_000): Promise<unknown> {
  const response = await send<{ result?: { value?: unknown; description?: string; type?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    tabId,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs },
    timeoutMs + 1000,
  );
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Evaluation failed');
  }
  return response.result?.value ?? (response.result?.type === 'undefined' ? null : response.result?.description ?? null);
}

export interface CdpClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}

export interface LayoutMetrics {
  pageX: number;
  pageY: number;
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
}

export async function getLayoutMetrics(tabId: number): Promise<LayoutMetrics> {
  const res = await send<{
    cssContentSize?: { width: number; height: number };
    contentSize?: { width: number; height: number };
    cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth: number; clientHeight: number };
  }>(tabId, 'Page.getLayoutMetrics', {}, 10_000);
  const content = res.cssContentSize ?? res.contentSize ?? { width: 1280, height: 720 };
  const vp = res.cssVisualViewport ?? { pageX: 0, pageY: 0, clientWidth: content.width, clientHeight: content.height };
  return {
    pageX: vp.pageX ?? 0,
    pageY: vp.pageY ?? 0,
    viewportWidth: Math.max(1, Math.ceil(vp.clientWidth)),
    viewportHeight: Math.max(1, Math.ceil(vp.clientHeight)),
    contentWidth: Math.max(1, Math.ceil(content.width)),
    contentHeight: Math.max(1, Math.ceil(content.height)),
  };
}

export async function captureScreenshot(
  tabId: number,
  options: {
    format: 'png' | 'jpeg';
    quality?: number;
    captureBeyondViewport?: boolean;
    clip?: CdpClip;
    emulateSize?: { width: number; height: number };
  },
): Promise<string> {
  const params: Record<string, unknown> = {
    format: options.format,
    fromSurface: true,
  };
  if (options.format === 'jpeg' && options.quality !== undefined) {
    params.quality = options.quality;
  }
  if (options.captureBeyondViewport) {
    params.captureBeyondViewport = true;
  }
  if (options.clip) {
    params.clip = {
      x: options.clip.x,
      y: options.clip.y,
      width: Math.max(1, Math.min(options.clip.width, 8192)),
      height: Math.max(1, Math.min(options.clip.height, 16384)),
      scale: options.clip.scale ?? 1,
    };
  }
  if (options.emulateSize) {
    await send(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: Math.max(1, Math.min(Math.ceil(options.emulateSize.width), 8192)),
      height: Math.max(1, Math.min(Math.ceil(options.emulateSize.height), 16384)),
      deviceScaleFactor: 0,
      mobile: false,
      dontSetVisibleSize: true,
    });
  }
  try {
    const res = await send<{ data: string }>(tabId, 'Page.captureScreenshot', params, 30_000);
    if (!res?.data) throw new Error('DevTools returned empty screenshot data');
    return res.data;
  } finally {
    if (options.emulateSize) {
      await send(tabId, 'Emulation.clearDeviceMetricsOverride', {}).catch(() => undefined);
    }
  }
}

export function pendingDialog(tabId: number): OpenDialogInfo | null {
  return openDialogs.get(tabId) ?? null;
}

export async function handleDialog(tabId: number, accept: boolean, promptText?: string): Promise<OpenDialogInfo | null> {
  const prev = openDialogs.get(tabId) ?? null;
  await send(
    tabId,
    'Page.handleJavaScriptDialog',
    { accept, ...(promptText !== undefined ? { promptText } : {}) },
    10_000,
  );
  openDialogs.delete(tabId);
  return prev;
}
