import { api, isChromium } from '../shared/api.ts';
import {
  classifyAndRankMediaCandidates,
  parseResolutionFromUrl,
  type DiscoveredMediaCandidate,
  type MediaCandidateKind,
  type MediaDiscoverySource,
  type RawDiscoveredUrl,
} from '../shared/media_rank.ts';
import { readNetworkCapture } from './network.ts';
import { assertScriptable, isBlank, sleep, tabUrl } from './page.ts';

export { classifyAndRankMediaCandidates, parseResolutionFromUrl };
export type { DiscoveredMediaCandidate, MediaCandidateKind, MediaDiscoverySource, RawDiscoveredUrl };

export interface DiscoveredMediaElement {
  tag: 'video' | 'audio';
  frameId: number;
  src: string;
  currentSrc: string;
  poster: string;
  width: number;
  height: number;
  duration: number | null;
  paused: boolean;
  muted: boolean;
  drmEncrypted: boolean;
  sources: Array<{ src: string; type: string }>;
}

export interface FrameMediaScan {
  url: string;
  title: string;
  elements: Omit<DiscoveredMediaElement, 'frameId'>[];
  rawUrls: RawDiscoveredUrl[];
}

export interface TabMediaReport {
  tabId: number;
  url: string;
  title: string;
  drmDetected: boolean;
  observedSegments: number;
  elements: DiscoveredMediaElement[];
  candidates: DiscoveredMediaCandidate[];
}

/**
 * Executed in the frame's MAIN world (read-only) to inspect live <video>/<audio> elements,
 * EME DRM state (`mediaKeys`), OpenGraph/JSON-LD video metadata, PerformanceResourceTiming
 * entries (retroactive even on already-open tabs), and structured player component variants.
 */
function scanFrameMediaInMainWorld(options: {
  includeAudio: boolean;
  scrollIntoView: boolean;
}): FrameMediaScan {
  const elements: FrameMediaScan['elements'] = [];
  const rawUrls: RawDiscoveredUrl[] = [];

  const pushRaw = (
    url: unknown,
    source: MediaDiscoverySource,
    extra: { mimeType?: string; bitrate?: number; width?: number; height?: number } = {},
  ) => {
    if (typeof url !== 'string') return;
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) return;
    let resolved = trimmed;
    if (!/^blob:/i.test(trimmed)) {
      try {
        resolved = new URL(trimmed, location.href).href;
      } catch {
        return;
      }
      if (!/^https?:/i.test(resolved)) return;
    }
    rawUrls.push({ url: resolved, source, ...extra });
  };

  const selector = options.includeAudio ? 'video, audio' : 'video';
  const mediaNodes = Array.from(document.querySelectorAll<HTMLMediaElement>(selector));

  if (options.scrollIntoView && mediaNodes.length > 0) {
    const firstVideo = mediaNodes.find((m) => m.localName === 'video') ?? mediaNodes[0];
    const rect = firstVideo.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) {
      try {
        firstVideo.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      } catch {
        // ignore
      }
    }
  }

  for (const el of mediaNodes) {
    const tag = el.localName === 'audio' ? 'audio' : 'video';
    const isVid = el instanceof HTMLVideoElement;
    const src = el.getAttribute('src') ?? '';
    const currentSrc = el.currentSrc ?? '';
    const poster = isVid ? el.poster || el.getAttribute('poster') || '' : '';
    const width = isVid ? el.videoWidth || Math.round(el.clientWidth) : 0;
    const height = isVid ? el.videoHeight || Math.round(el.clientHeight) : 0;
    const duration =
      typeof el.duration === 'number' && Number.isFinite(el.duration) && el.duration > 0
        ? Math.round(el.duration * 100) / 100
        : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drmEncrypted = Boolean((el as any).mediaKeys);
    const sources = Array.from(el.querySelectorAll('source')).map((s) => ({
      src: s.src || s.getAttribute('src') || '',
      type: s.type || s.getAttribute('type') || '',
    }));

    if (currentSrc) pushRaw(currentSrc, 'dom', { width: width || undefined, height: height || undefined });
    if (src && src !== currentSrc) pushRaw(src, 'dom', { width: width || undefined, height: height || undefined });
    for (const s of sources) {
      if (s.src) pushRaw(s.src, 'dom', { mimeType: s.type || undefined });
    }

    elements.push({
      tag,
      src,
      currentSrc,
      poster,
      width,
      height,
      duration,
      paused: el.paused,
      muted: el.muted,
      drmEncrypted,
      sources,
    });
  }

  // Bounded read-only inspection of SPA player component props/fibers attached around <video> / player roots
  const seedDomNodes = new Set<Element>(mediaNodes);
  for (const extra of Array.from(
    document.querySelectorAll(
      '[data-testid="videoPlayer"], [data-testid="videoComponent"], article[data-testid="tweet"]',
    ),
  ).slice(0, 8)) {
    seedDomNodes.add(extra);
  }

  const visitedObjs = new Set<object>();
  let budget = 320;
  const MEDIA_PROP_RE = /^(?:url|src|mp4|mp4Url|videoUrl|playbackUrl|hlsUrl|streamUrl|contentUrl|fallback_url|dash_url|hls_url)$/i;
  const MEDIA_URL_HINT_RE = /\.(?:mp4|m3u8|webm|mov|m4v|mpd|m4a|mp3)(?:[?#]|$)|video\.twimg\.com|v\.redd\.it/i;

  const inspectObjectGraph = (root: unknown, depthLimit: number) => {
    const queue: Array<{ val: unknown; depth: number }> = [{ val: root, depth: 0 }];
    while (queue.length > 0 && budget > 0) {
      const { val, depth } = queue.shift()!;
      if (!val || typeof val !== 'object') continue;
      if (val instanceof Node || val instanceof Window) continue;
      if (visitedObjs.has(val)) continue;
      visitedObjs.add(val);
      budget--;

      if (Array.isArray(val)) {
        for (let i = 0; i < Math.min(val.length, 16); i++) {
          const item = val[i];
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const rec = item as Record<string, unknown>;
            const u = rec.url ?? rec.src;
            if (typeof u === 'string' && /^https?:\/\//i.test(u) && MEDIA_URL_HINT_RE.test(u)) {
              const ct = typeof rec.content_type === 'string' ? rec.content_type : typeof rec.type === 'string' ? rec.type : undefined;
              const br = typeof rec.bitrate === 'number' && Number.isFinite(rec.bitrate) ? rec.bitrate : undefined;
              const w = typeof rec.width === 'number' ? rec.width : undefined;
              const h = typeof rec.height === 'number' ? rec.height : undefined;
              pushRaw(u, 'component_state', { mimeType: ct, bitrate: br, width: w, height: h });
            }
          }
          if (depth < depthLimit) queue.push({ val: item, depth: depth + 1 });
        }
        continue;
      }

      const obj = val as Record<string, unknown>;
      let keys: string[];
      try {
        keys = Object.keys(obj);
      } catch {
        continue;
      }
      for (let kIdx = 0; kIdx < Math.min(keys.length, 40); kIdx++) {
        const k = keys[kIdx];
        if (k === 'ownerDocument' || k === 'stateNode' || k === 'alternate' || k === 'sibling') continue;
        let child: unknown;
        try {
          child = obj[k];
        } catch {
          continue;
        }
        if (typeof child === 'string') {
          if ((MEDIA_PROP_RE.test(k) || MEDIA_URL_HINT_RE.test(child)) && /^https?:\/\//i.test(child) && MEDIA_URL_HINT_RE.test(child)) {
            pushRaw(child, 'component_state');
          }
        } else if (child && typeof child === 'object' && depth < depthLimit) {
          queue.push({ val: child, depth: depth + 1 });
        }
      }
    }
  };

  for (const startNode of seedDomNodes) {
    let cur: Element | null = startNode;
    for (let anc = 0; cur && anc < 10 && budget > 0; anc++, cur = cur.parentElement) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawNode = cur as any;
      for (const key of Object.keys(rawNode)) {
        if (key.startsWith('__reactProps$') || key.startsWith('__vueParentComponent')) {
          inspectObjectGraph(rawNode[key], 6);
        } else if (key.startsWith('__reactFiber$')) {
          let fiber = rawNode[key];
          for (let fHop = 0; fiber && fHop < 20 && budget > 0; fHop++, fiber = fiber.return) {
            if (fiber.memoizedProps) inspectObjectGraph(fiber.memoizedProps, 5);
            if (fiber.memoizedState) inspectObjectGraph(fiber.memoizedState, 4);
          }
        }
      }
    }
  }

  // OpenGraph / Twitter Card / Preload metadata
  for (const meta of Array.from(
    document.querySelectorAll<HTMLMetaElement>(
      'meta[property^="og:video"], meta[name^="twitter:player:stream"], meta[itemprop="contentUrl"]',
    ),
  )) {
    const content = meta.getAttribute('content') ?? '';
    if (content && !content.endsWith('.swf') && !content.includes('/i/videos/tweet/')) {
      pushRaw(content, 'meta');
    }
  }
  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="video"], link[rel="preload"][as="audio"]'))) {
    if (link.href) pushRaw(link.href, 'meta', { mimeType: link.type || undefined });
  }
  for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')).slice(0, 10)) {
    const txt = script.textContent ?? '';
    if (!txt.includes('VideoObject') && !txt.includes('contentUrl')) continue;
    try {
      const parsed = JSON.parse(txt);
      const stack = [parsed];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) {
          for (const it of node) stack.push(it);
          continue;
        }
        const rec = node as Record<string, unknown>;
        if (typeof rec.contentUrl === 'string') pushRaw(rec.contentUrl, 'meta');
        for (const v of Object.values(rec)) {
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }

  // Browser PerformanceResourceTiming buffer (retroactive across already-open tabs!)
  try {
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (const entry of resources) {
      const name = entry.name || '';
      if (!/^https?:/i.test(name)) continue;
      const initType = (entry.initiatorType || '').toLowerCase();
      if (
        initType === 'video' ||
        initType === 'audio' ||
        /\.(?:mp4|webm|mov|m4v|m3u8|mpd|m4s|ts|mp3|m4a|aac|ogg|opus)(?:[?#]|$)/i.test(name) ||
        /video\.twimg\.com|v\.redd\.it/i.test(name)
      ) {
        pushRaw(name, 'resource_timing');
      }
    }
  } catch {
    // ignore
  }

  return {
    url: location.href,
    title: document.title ?? '',
    elements,
    rawUrls,
  };
}

export async function inspectTabMedia(
  tab: chrome.tabs.Tab,
  options: { includeAudio?: boolean; scrollIntoView?: boolean } = {},
): Promise<TabMediaReport> {
  const url = tabUrl(tab);
  if (isBlank(url)) {
    return {
      tabId: tab.id!,
      url,
      title: tab.title ?? '',
      drmDetected: false,
      observedSegments: 0,
      elements: [],
      candidates: [],
    };
  }
  assertScriptable(tab);
  const includeAudio = options.includeAudio !== false;
  const scrollIntoView = options.scrollIntoView !== false;
  const immediate = isChromium ? { injectImmediately: true } : {};

  const runScan = async (allFrames: boolean) => {
    const res = await api.scripting.executeScript({
      target: allFrames ? { tabId: tab.id!, allFrames: true } : { tabId: tab.id!, frameIds: [0] },
      world: 'MAIN',
      func: scanFrameMediaInMainWorld,
      args: [{ includeAudio, scrollIntoView }],
      ...immediate,
    });
    return res ?? [];
  };

  let rawFrames = await Promise.race([
    runScan(true).catch(() => null),
    sleep(1_500).then(() => null),
  ]);
  if (!rawFrames) {
    rawFrames = await runScan(false);
  }

  const elements: DiscoveredMediaElement[] = [];
  const rawUrls: Array<RawDiscoveredUrl & { frameId: number }> = [];

  for (const entry of rawFrames) {
    const frameId = entry?.frameId ?? 0;
    const scan = entry?.result as FrameMediaScan | undefined;
    if (!scan) continue;
    for (const el of scan.elements ?? []) {
      elements.push({ ...el, frameId });
    }
    for (const r of scan.rawUrls ?? []) {
      rawUrls.push({ ...r, frameId });
    }
  }

  // Merge any active or historical network capture entries for this tab
  const net = readNetworkCapture(tab.id!, { limit: 500 });
  for (const ex of net.exchanges) {
    if (ex.status !== null && ex.status >= 400) continue;
    const ct = ex.responseHeaders?.['content-type'] ?? '';
    if (
      ex.resourceType === 'media' ||
      /\.(?:mp4|webm|mov|m4v|m3u8|mpd|m4s|ts|mp3|m4a|aac|ogg|opus)(?:[?#]|$)/i.test(ex.url) ||
      /video\/|audio\/|mpegurl|dash\+xml/i.test(ct)
    ) {
      rawUrls.push({
        url: ex.url,
        mimeType: ct || undefined,
        source: 'network_capture',
        frameId: 0,
      });
    }
  }

  let { candidates, observedSegments } = classifyAndRankMediaCandidates(rawUrls, includeAudio);

  // If a <video> element is present on the page (e.g. lazy SPA player just scrolled into view)
  // and no HTTP stream candidate has buffered yet, wait briefly (450 ms) and rescan once!
  if (
    scrollIntoView &&
    elements.some((e) => e.tag === 'video') &&
    !candidates.some((c) => c.kind !== 'blob')
  ) {
    await sleep(450);
    const retryFrames = await runScan(false).catch(() => []);
    for (const entry of retryFrames) {
      const frameId = entry?.frameId ?? 0;
      const scan = entry?.result as FrameMediaScan | undefined;
      for (const r of scan?.rawUrls ?? []) {
        rawUrls.push({ ...r, frameId });
      }
    }
    ({ candidates, observedSegments } = classifyAndRankMediaCandidates(rawUrls, includeAudio));
  }

  const drmDetected = elements.some((e) => e.drmEncrypted);
  return {
    tabId: tab.id!,
    url,
    title: tab.title ?? '',
    drmDetected,
    observedSegments,
    elements,
    candidates,
  };
}
