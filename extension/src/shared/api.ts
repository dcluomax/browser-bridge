import type { BrowserKind } from './protocol.ts';

declare const __TARGET__: 'chromium' | 'firefox';

/** Build target selected by build.mjs; Firefox uses the promise-based `browser` namespace. */
export const TARGET: 'chromium' | 'firefox' = typeof __TARGET__ === 'string' ? __TARGET__ : 'chromium';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

/** WebExtension API namespace. Both Chromium MV3 and Firefox return promises from these calls. */
export const api: typeof chrome = (g.browser ?? g.chrome) as typeof chrome;

/** Toolbar action API: `action` in MV3 (Chromium), `browserAction` in MV2 (Firefox). */
export const actionApi: typeof chrome.action = (api?.action ?? (api as unknown as { browserAction?: typeof chrome.action } | undefined)?.browserAction) as typeof chrome.action;

export const isChromium = TARGET === 'chromium';

export async function detectBrowser(): Promise<{ kind: BrowserKind; version: string }> {
  if (!isChromium) {
    try {
      const info = await g.browser.runtime.getBrowserInfo();
      return { kind: 'firefox', version: String(info.version ?? '') };
    } catch {
      return { kind: 'firefox', version: '' };
    }
  }
  const ua: string = g.navigator?.userAgent ?? '';
  const brands: Array<{ brand: string; version: string }> = g.navigator?.userAgentData?.brands ?? [];
  const edge = brands.find((b) => /Edge/i.test(b.brand)) ?? (ua.includes('Edg/') ? { brand: 'Microsoft Edge', version: /Edg\/([\d.]+)/.exec(ua)?.[1] ?? '' } : undefined);
  if (edge) return { kind: 'edge', version: edge.version };
  const chrome = brands.find((b) => b.brand === 'Google Chrome');
  if (chrome) return { kind: 'chrome', version: chrome.version };
  const version = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? '';
  return { kind: 'chromium', version };
}
