export interface PerformanceOptions {
  includeResources?: boolean;
  maxEntries?: number;
}

function finite(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function evidenceUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol}[omitted]`;
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid URL omitted]';
  }
}

export function readPerformanceEvidence(options: PerformanceOptions = {}) {
  if (options.includeResources !== undefined && typeof options.includeResources !== 'boolean') {
    throw new Error('includeResources must be a boolean.');
  }
  const maxEntries = options.maxEntries ?? 50;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 200) {
    throw new Error('maxEntries must be an integer from 1 to 200.');
  }
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const resources = options.includeResources ? performance.getEntriesByType('resource') as PerformanceResourceTiming[] : [];
  return {
    source: 'browser-performance-api',
    capturedAt: Date.now(),
    timeOrigin: performance.timeOrigin,
    navigation: navigation ? {
      type: navigation.type,
      startTime: finite(navigation.startTime),
      durationMs: finite(navigation.duration),
      ttfbMs: navigation.responseStart > 0 ? finite(navigation.responseStart - navigation.requestStart) : null,
      responseEndMs: navigation.responseEnd > 0 ? finite(navigation.responseEnd) : null,
      domContentLoadedMs: navigation.domContentLoadedEventEnd > 0 ? finite(navigation.domContentLoadedEventEnd) : null,
      loadEventMs: navigation.loadEventEnd > 0 ? finite(navigation.loadEventEnd) : null,
      transferSize: finite(navigation.transferSize),
      protocol: navigation.nextHopProtocol,
    } : null,
    resources: resources.slice(-maxEntries).map((entry) => ({
      url: evidenceUrl(entry.name),
      initiatorType: entry.initiatorType,
      startTime: finite(entry.startTime),
      durationMs: finite(entry.duration),
      responseStartMs: entry.responseStart > 0 ? finite(entry.responseStart) : null,
      responseEndMs: entry.responseEnd > 0 ? finite(entry.responseEnd) : null,
      transferSize: entry.responseStart > 0 ? finite(entry.transferSize) : null,
      encodedBodySize: entry.responseStart > 0 ? finite(entry.encodedBodySize) : null,
      protocol: entry.nextHopProtocol || null,
      detailedTimingAvailable: entry.responseStart > 0,
    })),
    totalResources: resources.length,
    truncated: resources.length > maxEntries,
    limitations: [
      'Browser point samples are not Web Vitals or Browser Bridge operation timings.',
      'Cross-origin timing detail requires the server to allow Timing-Allow-Origin.',
      'Only entries retained by this document are available. No performance buffer is cleared.',
      'Resource URL credentials, query strings and fragments are omitted.',
    ],
  };
}
