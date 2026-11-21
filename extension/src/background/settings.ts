import { api } from '../shared/api.ts';
import { isLocaleSetting, type LocaleSetting } from '../shared/i18n.ts';

export interface Settings {
  /** When false (default), agents only see tabs the user shared or the agent opened. */
  accessAllTabs: boolean;
  /** Global read-only lock: when true, all mutating actions across all tabs are blocked. */
  readOnlyMode: boolean;
  /** Chromium only: use chrome.debugger for trusted mouse/keyboard input. */
  trustedInput: boolean;
  /** Allows the optional browser_evaluate tool to run page scripts. */
  allowEvaluate: boolean;
  /** Chromium only: place background agent-opened tabs into a collapsed [Agent] tab group. */
  groupAgentTabs: boolean;
  /** Minutes before idle unnamed agent-opened tabs auto-close (0 = never). */
  idleCloseMinutes: number;
  /** Human-friendly profile label reported to agents, e.g. "Work". */
  label: string;
  /** UI language preference ('auto' follows browser UI locale). */
  locale: LocaleSetting;
}

export const DEFAULT_SETTINGS: Settings = {
  accessAllTabs: false,
  readOnlyMode: false,
  trustedInput: true,
  allowEvaluate: false,
  groupAgentTabs: true,
  idleCloseMinutes: 10,
  label: '',
  locale: 'auto',
};

let current: Settings = { ...DEFAULT_SETTINGS };
let instanceId = '';

function randomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sanitize(patch: Partial<Settings>): Partial<Settings> {
  const clean: Partial<Settings> = {};
  if (typeof patch.accessAllTabs === 'boolean') clean.accessAllTabs = patch.accessAllTabs;
  if (typeof patch.readOnlyMode === 'boolean') clean.readOnlyMode = patch.readOnlyMode;
  if (typeof patch.trustedInput === 'boolean') clean.trustedInput = patch.trustedInput;
  if (typeof patch.allowEvaluate === 'boolean') clean.allowEvaluate = patch.allowEvaluate;
  if (typeof patch.groupAgentTabs === 'boolean') clean.groupAgentTabs = patch.groupAgentTabs;
  if (typeof patch.idleCloseMinutes === 'number' && Number.isFinite(patch.idleCloseMinutes)) {
    clean.idleCloseMinutes = Math.max(0, Math.min(Math.round(patch.idleCloseMinutes), 1440));
  }
  if (typeof patch.label === 'string') clean.label = patch.label.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40);
  if (isLocaleSetting(patch.locale)) clean.locale = patch.locale;
  return clean;
}

export async function loadSettings(): Promise<void> {
  const stored = (await api.storage.local.get(['settings', 'instanceId'])) as { settings?: Partial<Settings>; instanceId?: string };
  current = { ...DEFAULT_SETTINGS, ...sanitize(stored.settings ?? {}) };
  instanceId = typeof stored.instanceId === 'string' && /^[0-9a-f]{12}$/.test(stored.instanceId) ? stored.instanceId : '';
  if (!instanceId) {
    instanceId = randomId();
    await api.storage.local.set({ instanceId });
  }
}

export function settings(): Readonly<Settings> {
  return current;
}

export function getInstanceId(): string {
  return instanceId;
}

export async function adoptInstanceId(nextId: string): Promise<void> {
  if (!/^[0-9a-f]{12}$/.test(nextId) || nextId === instanceId) return;
  instanceId = nextId;
  await api.storage.local.set({ instanceId });
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  current = { ...current, ...sanitize(patch) };
  await api.storage.local.set({ settings: current });
  return current;
}
