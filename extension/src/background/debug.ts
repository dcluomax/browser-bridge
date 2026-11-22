import { api } from '../shared/api.ts';
import { parseLocator, type Locator } from '../shared/locators.ts';
import { BridgeError } from '../shared/protocol.ts';
import { clearInterception, clearOwnerInterceptions, forgetInterception, readDebuggerMetrics, runInterception, validateInterceptionRules } from './developer.ts';
import { dropOwnerNetworkCaptures, exportNetworkHar } from './network.ts';
import { callFrame, type ContentMethod } from './page.ts';
import type { TabRegistry } from './tabs.ts';
import type { PatchChange } from '../content/patches.ts';

type Params = Record<string, unknown>;
interface Target { ref?: string; locator?: Locator }
interface DocumentState { documentId: string; frameId: number; tabId: number }

const METHODS = new Set(['page.styles', 'page.layout', 'page.domBaseline', 'page.patch', 'page.performance', 'page.har', 'page.debugger', 'page.intercept']);

function integer(value: unknown, name: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BridgeError('bad_request', `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function action(params: Params, fallback: string, allowed: readonly string[]): string {
  const value = params.action ?? fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new BridgeError('bad_request', `action must be one of ${allowed.join(', ')}.`);
  }
  return value;
}

function id(params: Params, required = true): string | undefined {
  if (params.id === undefined && !required) return undefined;
  if (typeof params.id !== 'string' || !params.id || params.id.length > 100) {
    throw new BridgeError('bad_request', 'id must be a non-empty handle returned by this session.');
  }
  return params.id;
}

function stringMap(value: unknown, name: string): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('bad_request', `${name} must be an object.`);
  const entries: Array<readonly [string, string | null]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry !== 'string') throw new BridgeError('bad_request', `${name} entries must be strings or null.`);
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

function frameRefs(value: unknown, frameId: number): unknown {
  if (Array.isArray(value)) return value.map((entry) => frameRefs(entry, frameId));
  if (!value || typeof value !== 'object') return value;
  const scoped: Params = {};
  for (const [key, entry] of Object.entries(value)) {
    scoped[key] = ['ref', 'rootRef', 'parentRef', 'obstructedBy'].includes(key) && typeof entry === 'string' && /^e\d+$/.test(entry)
      ? `f${frameId}${entry}` : frameRefs(entry, frameId);
  }
  return scoped;
}

export function isDebugMethod(method: string): boolean { return METHODS.has(method); }

export function isDebugReadSafe(method: string, params: Params): boolean {
  if (!isDebugMethod(method)) return false;
  if (method === 'page.patch' || method === 'page.intercept') return (params.action ?? 'list') === 'list';
  return true;
}

export function debugTarget(params: Params): { target: Target | undefined; frameId: number } {
  const explicitFrame = params.frameId === undefined ? undefined : integer(params.frameId, 'frameId', 0, Number.MAX_SAFE_INTEGER);
  if (params.ref !== undefined && params.locator !== undefined) throw new BridgeError('bad_request', 'Provide ref or locator, not both.');
  if (params.ref !== undefined) {
    if (typeof params.ref !== 'string') throw new BridgeError('bad_request', 'ref must be a string.');
    const match = /^(?:f(\d+))?(e\d+)$/.exec(params.ref);
    if (!match) throw new BridgeError('bad_ref', 'Use a ref returned by this document.');
    const frameId = integer(match[1] === undefined ? 0 : Number(match[1]), 'frameId', 0, Number.MAX_SAFE_INTEGER);
    if (explicitFrame !== undefined && explicitFrame !== frameId) throw new BridgeError('bad_request', 'frameId conflicts with ref.');
    return { target: { ref: match[2] }, frameId };
  }
  if (params.locator !== undefined) {
    const locator = parseLocator(params.locator);
    const frameId = locator.frameId ?? explicitFrame ?? 0;
    if (explicitFrame !== undefined && locator.frameId !== undefined && explicitFrame !== locator.frameId) {
      throw new BridgeError('bad_request', 'frameId conflicts with locator.');
    }
    return { target: { locator }, frameId };
  }
  return { target: undefined, frameId: explicitFrame ?? 0 };
}

export class DebugCommands {
  private readonly documents = new Map<string, Map<string, DocumentState>>();

  constructor(private readonly registry: TabRegistry) {}

  async run(owner: string, method: string, params: Params): Promise<unknown> {
    if (params.readOnly !== undefined && typeof params.readOnly !== 'boolean') {
      throw new BridgeError('bad_request', 'readOnly must be a boolean.');
    }
    if (params.readOnly === true && !isDebugReadSafe(method, params)) {
      throw new BridgeError('read_only', `${method} modifies the page and is blocked in read-only mode.`);
    }
    const requestedTab = params.tabId === undefined ? undefined : integer(params.tabId, 'tabId', 0, Number.MAX_SAFE_INTEGER);
    const tab = await this.registry.resolveTab(owner, requestedTab);
    const tabId = tab.id!;
    const { target, frameId } = debugTarget(params);
    const frameCall = async (contentMethod: ContentMethod, args: unknown[] = []): Promise<Params> => {
      const result = await callFrame<unknown>(tab, frameId, contentMethod, args);
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new BridgeError('protocol_error', 'The diagnostic operation did not return an object.');
      }
      return result as Params;
    };
    const checkDocumentQuota = () => {
      const owned = this.documents.get(owner);
      if (owned && !owned.has(`${tabId}:${frameId}`) && owned.size >= 100) {
        throw new BridgeError('quota_exceeded', 'Release diagnostic state before using more than 100 documents.');
      }
    };
    const remember = (result: Params) => {
      if (typeof result.documentId !== 'string' || !result.documentId) throw new BridgeError('protocol_error', 'A diagnostic document ID is missing.');
      let owned = this.documents.get(owner);
      if (!owned) this.documents.set(owner, owned = new Map());
      const key = `${tabId}:${frameId}`;
      owned.set(key, { tabId, frameId, documentId: result.documentId });
    };
    const scoped = (result: Params) => ({
      ...(frameId ? frameRefs(result, frameId) as Params : result), tabId, frameId,
    });
    switch (method) {
      case 'page.styles': {
        const operation = action(params, 'computed', ['computed', 'context']);
        if (operation === 'context') return scoped(await frameCall('debugStyleContext', [target]));
        if (params.properties !== undefined && (!Array.isArray(params.properties) || params.properties.some((p) => typeof p !== 'string'))) {
          throw new BridgeError('bad_request', 'properties must be an array of CSS property names.');
        }
        if (params.pseudo !== undefined && typeof params.pseudo !== 'string') throw new BridgeError('bad_request', 'pseudo must be a string.');
        return scoped(await frameCall('debugStyles', [target, { properties: params.properties, pseudo: params.pseudo }]));
      }
      case 'page.layout': {
        const operation = action(params, 'box', ['box', 'hitTest']);
        if (operation === 'box') return scoped(await frameCall('debugBoxModel', [target]));
        if (typeof params.x !== 'number' || typeof params.y !== 'number' || !Number.isFinite(params.x) || !Number.isFinite(params.y)) {
          throw new BridgeError('bad_request', 'Hit testing requires finite viewport coordinates x and y.');
        }
        return scoped(await frameCall('debugHitTest', [{ x: params.x, y: params.y }]));
      }
      case 'page.domBaseline': {
        const operation = action(params, 'create', ['create', 'compare', 'describe', 'release']);
        if (operation === 'create') {
          checkDocumentQuota();
          const result = await frameCall('debugBaselineCreate', [owner, {
            target, maxNodes: params.maxNodes, maxText: params.maxText,
          }]);
          remember(result);
          return scoped(result);
        }
        const handle = id(params);
        if (operation === 'compare') return scoped(await frameCall('debugBaselineCompare', [owner, handle, { maxChanges: params.maxChanges }]));
        if (operation === 'describe') return scoped(await frameCall('debugBaselineDescribe', [owner, handle]));
        return scoped(await frameCall('debugBaselineRelease', [owner, handle]));
      }
      case 'page.patch': {
        const operation = action(params, 'list', ['apply', 'list', 'rollback', 'commit']);
        if (operation === 'list') return scoped(await frameCall('debugPatchList', [owner]));
        this.registry.requireTabWrite(tabId, `page.patch ${operation}`);
        if (operation === 'apply') {
          checkDocumentQuota();
          if (!Array.isArray(params.changes)) throw new BridgeError('bad_request', 'changes must be an array.');
          const changes = params.changes.map((raw): PatchChange => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BridgeError('bad_request', 'Each patch change must be an object.');
            const change = raw as Record<string, unknown>;
            if (Object.keys(change).some((key) => !['target', 'styles', 'attributes', 'text'].includes(key))) {
              throw new BridgeError('bad_request', 'A patch change contains unsupported fields.');
            }
            if (!change.target || typeof change.target !== 'object' || Array.isArray(change.target)) {
              throw new BridgeError('bad_request', 'Each patch change requires a target.');
            }
            const resolved = debugTarget({ ...(change.target as Params), frameId });
            if (!resolved.target || resolved.frameId !== frameId) throw new BridgeError('bad_request', 'A patch must target one frame. Set frameId for iframe patches.');
            if (change.text !== undefined && typeof change.text !== 'string') throw new BridgeError('bad_request', 'Patch text must be a string.');
            return {
              target: resolved.target,
              ...(change.styles === undefined ? {} : { styles: stringMap(change.styles, 'styles') }),
              ...(change.attributes === undefined ? {} : { attributes: stringMap(change.attributes, 'attributes') }),
              ...(change.text === undefined ? {} : { text: change.text }),
            };
          });
          const result = await frameCall('debugPatchApply', [owner, changes, { ttlMs: params.ttlMs, label: params.label }]);
          remember(result);
          return scoped(result);
        }
        if (operation === 'rollback') return scoped(await frameCall('debugPatchRollback', [owner, id(params, false)]));
        return scoped(await frameCall('debugPatchCommit', [owner, id(params)]));
      }
      case 'page.performance':
        return scoped(await frameCall('debugPerformance', [{ includeResources: params.includeResources, maxEntries: params.maxEntries }]));
      case 'page.har':
        if (params.onlyFailures !== undefined && typeof params.onlyFailures !== 'boolean') throw new BridgeError('bad_request', 'onlyFailures must be a boolean.');
        return { tabId, ...exportNetworkHar(tabId, owner, {
          limit: params.limit === undefined ? undefined : integer(params.limit, 'limit', 1, 500),
          onlyFailures: params.onlyFailures,
        }) };
      case 'page.debugger':
        action(params, 'metrics', ['metrics']);
        return { tabId, ...await readDebuggerMetrics(tabId) };
      case 'page.intercept': {
        const operation = action(params, 'list', ['list', 'set', 'clear']);
        if (operation !== 'list') this.registry.requireTabWrite(tabId, `page.intercept ${operation}`);
        if (operation === 'set') {
          const rules = validateInterceptionRules(params.rules);
          for (const rule of rules) this.registry.assertNavigationAllowed(owner, tabId, rule.urlPattern.replaceAll('*', ''));
        }
        return { tabId, ...await runInterception(tabId, owner, params) };
      }
      default: throw new BridgeError('unknown_method', `Unknown diagnostic method "${method}".`);
    }
  }

  async releaseOwner(owner: string): Promise<void> {
    const owned = this.documents.get(owner);
    await this.releaseDocuments(owner, [...owned?.values() ?? []]);
    this.documents.delete(owner);
    dropOwnerNetworkCaptures(owner);
    await clearOwnerInterceptions(owner);
  }

  async releaseAll(): Promise<void> {
    const owners = new Set([...this.documents.keys(), ...this.registry.sessions.keys()]);
    await Promise.all([...owners].map((owner) => this.releaseOwner(owner)));
  }

  async releaseTabs(tabIds: readonly number[]): Promise<void> {
    const tabs = new Set(tabIds);
    await Promise.all([...this.documents].map(async ([owner, owned]) => {
      const states = [...owned.values()].filter((state) => tabs.has(state.tabId));
      await this.releaseDocuments(owner, states);
      for (const state of states) {
        const key = `${state.tabId}:${state.frameId}`;
        if (owned.get(key)?.documentId === state.documentId) owned.delete(key);
      }
      if (!owned.size) this.documents.delete(owner);
    }));
    await Promise.all(tabIds.map((tabId) => clearInterception(tabId)));
  }

  forgetTab(tabId: number): void {
    for (const [owner, owned] of this.documents) {
      for (const [key, state] of owned) if (state.tabId === tabId) owned.delete(key);
      if (!owned.size) this.documents.delete(owner);
    }
    forgetInterception(tabId);
  }

  private async releaseDocuments(owner: string, states: DocumentState[]): Promise<void> {
    await Promise.all(states.map(async (state) => {
      try {
        const tab = await api.tabs.get(state.tabId);
        const result = await callFrame<{ patches?: { errors?: unknown[]; conflicts?: unknown[] } }>(tab, state.frameId, 'releaseDebugOwner', [owner, state.documentId]);
        const failures = result?.patches?.errors?.length ?? result?.patches?.conflicts?.length ?? 0;
        if (failures) {
          console.error(`Browser Bridge diagnostic cleanup reported ${failures} patch conflict(s).`);
        }
      } catch (error) {
        if (error instanceof BridgeError && ['no_tab', 'restricted', 'error_page'].includes(error.code)) return;
        console.error('Browser Bridge diagnostic cleanup failed:', error instanceof Error ? error.message : String(error));
      }
    }));
  }
}
