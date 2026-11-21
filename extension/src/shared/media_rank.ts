export type MediaCandidateKind =
  | 'progressive'
  | 'hls_master'
  | 'hls_variant'
  | 'dash'
  | 'audio'
  | 'blob';

export type MediaDiscoverySource =
  | 'dom'
  | 'component_state'
  | 'meta'
  | 'resource_timing'
  | 'network_capture';

export interface RawDiscoveredUrl {
  url: string;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  source: MediaDiscoverySource;
}

export interface DiscoveredMediaCandidate {
  url: string;
  kind: MediaCandidateKind;
  container: string;
  mimeType?: string;
  source: MediaDiscoverySource;
  frameId: number;
  bitrate?: number;
  width?: number;
  height?: number;
  score: number;
}

const SEGMENT_PATH_RE = /\.(?:m4s|ts|aac|vtt|webvtt|srt)(?:[?#]|$)|\/vid\/[^/]+\/[1-9]\d*\/\d+\//i;
const INIT_HEADER_PATH_RE = /\/vid\/[^/]+\/0\/0\/|(?:^|\/)init(?:[-_][^/?#]*)?\.(?:mp4|m4s)(?:[?#]|$)/i;
const RESOLUTION_IN_URL_RE = /(?:\/|[_=-])(\d{3,4})x(\d{3,4})(?:\/|[_=.-]|$)/i;

export function parseResolutionFromUrl(url: string): { width: number; height: number } | undefined {
  const m = RESOLUTION_IN_URL_RE.exec(url);
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width >= 100 && width <= 7680 && height >= 100 && height <= 7680) {
    return { width, height };
  }
  return undefined;
}

export function classifyAndRankMediaCandidates(
  inputs: Array<RawDiscoveredUrl & { frameId: number }>,
  includeAudio = true,
): { candidates: DiscoveredMediaCandidate[]; observedSegments: number } {
  const byUrl = new Map<string, DiscoveredMediaCandidate>();
  let observedSegments = 0;

  for (const item of inputs) {
    const raw = (item.url ?? '').trim();
    if (!raw || raw.includes('[REDACTED]')) continue;

    if (/^blob:https?:\/\//i.test(raw)) {
      if (!byUrl.has(raw)) {
        byUrl.set(raw, {
          url: raw,
          kind: 'blob',
          container: 'blob',
          mimeType: item.mimeType,
          source: item.source,
          frameId: item.frameId,
          width: item.width,
          height: item.height,
          score: 500,
        });
      }
      continue;
    }

    if (!/^https?:\/\//i.test(raw)) continue;
    const pathPart = raw.split(/[?#]/)[0];

    if (INIT_HEADER_PATH_RE.test(pathPart) || SEGMENT_PATH_RE.test(pathPart) || /\/(?:vid|aud)\/[^/]+\/\d+\/\d+\//.test(pathPart)) {
      observedSegments++;
      continue;
    }

    const mime = (item.mimeType ?? '').toLowerCase();
    let kind: MediaCandidateKind | null = null;
    let container = '';

    if (/\.m3u8$/i.test(pathPart) || mime.includes('mpegurl') || mime.includes('x-mpegurl')) {
      container = 'm3u8';
      const isVariant =
        /\/(?:avc1|hevc|hvc1|vp9|av01|mp4a|aud|sub)\//i.test(pathPart) ||
        /chunklist|variant|index_\d+/i.test(pathPart) ||
        RESOLUTION_IN_URL_RE.test(pathPart);
      kind = isVariant ? 'hls_variant' : 'hls_master';
    } else if (/\.mpd$/i.test(pathPart) || mime.includes('dash+xml')) {
      kind = 'dash';
      container = 'mpd';
    } else if (/\.(?:m4a|mp3|aac|ogg|opus|wav|flac)$/i.test(pathPart) || mime.startsWith('audio/')) {
      if (!includeAudio) continue;
      kind = 'audio';
      const extMatch = /\.([a-z0-9]+)$/i.exec(pathPart);
      container = extMatch ? extMatch[1].toLowerCase() : 'm4a';
    } else if (/\.(?:mp4|webm|mov|m4v|mkv)$/i.test(pathPart) || mime.startsWith('video/')) {
      kind = 'progressive';
      const extMatch = /\.([a-z0-9]+)$/i.exec(pathPart);
      container = extMatch ? extMatch[1].toLowerCase() : mime.includes('webm') ? 'webm' : 'mp4';
    } else {
      continue;
    }

    const inferredRes = parseResolutionFromUrl(pathPart);
    const width = item.width || inferredRes?.width;
    const height = item.height || inferredRes?.height;
    const bitrate = item.bitrate;
    const resBonus = width && height ? Math.min(600, Math.round((width * height) / 4000)) : 0;
    const bitrateBonus = bitrate ? Math.min(999, Math.round(bitrate / 10_000)) : 0;

    const baseScore =
      kind === 'progressive'
        ? 4000
        : kind === 'hls_master'
          ? 3000
          : kind === 'hls_variant'
            ? 2000
            : kind === 'dash'
              ? 1500
              : 1000;
    const score = baseScore + bitrateBonus + resBonus;

    const prev = byUrl.get(raw);
    if (!prev || score > prev.score) {
      byUrl.set(raw, {
        url: raw,
        kind,
        container,
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        source: item.source,
        frameId: item.frameId,
        ...(bitrate ? { bitrate } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        score,
      });
    }
  }

  const candidates = [...byUrl.values()].sort((a, b) => b.score - a.score);
  return { candidates, observedSegments };
}
