/*
 * Lightweight, zero-privilege WebMCP (W3C / Chrome ModelContext) collector in the MAIN world.
 * Captures tools registered via `document.modelContext.registerTool` or `navigator.modelContext.registerTool`
 * (and forwards to native Chrome WebMCP when available) so Browser Bridge can discover and invoke
 * page-provided WebMCP tools across Edge, Chrome, and Firefox.
 */
interface WebMcpAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
}

interface WebMcpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpAnnotations;
  execute: (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => unknown | Promise<unknown>;
}

(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.__bbWebMcpInstalled) return;
  g.__bbWebMcpInstalled = true;

  const tools = new Map<string, WebMcpTool>();

  function recordTool(tool: WebMcpTool): void {
    if (tool && typeof tool.name === 'string' && tool.name.trim() && typeof tool.execute === 'function') {
      tools.set(tool.name.trim(), tool);
    }
  }

  function wrapOrInstall(target: Record<string, unknown> | undefined): void {
    if (!target) return;
    const existing = target.modelContext as Record<string, unknown> | undefined;
    if (existing && typeof existing.registerTool === 'function') {
      const origRegister = existing.registerTool.bind(existing);
      existing.registerTool = async (tool: WebMcpTool, opts?: { signal?: AbortSignal }) => {
        recordTool(tool);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
        }
        return await origRegister(tool, opts);
      };
      if (typeof existing.unregisterTool === 'function') {
        const origUnreg = existing.unregisterTool.bind(existing);
        existing.unregisterTool = async (name: string) => {
          tools.delete(name);
          return await origUnreg(name);
        };
      }
      if (typeof existing.provideContext === 'function') {
        const origProvide = existing.provideContext.bind(existing);
        existing.provideContext = async (ctx: { tools?: WebMcpTool[] }) => {
          tools.clear();
          for (const t of ctx?.tools ?? []) recordTool(t);
          return await origProvide(ctx);
        };
      }
      if (typeof existing.clearContext === 'function') {
        const origClear = existing.clearContext.bind(existing);
        existing.clearContext = async () => {
          tools.clear();
          return await origClear();
        };
      }
      return;
    }

    const et = new EventTarget();
    const mc = Object.assign(et, {
      async registerTool(tool: WebMcpTool, opts?: { signal?: AbortSignal }): Promise<void> {
        recordTool(tool);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
        }
      },
      async unregisterTool(name: string): Promise<void> {
        tools.delete(name);
      },
      async provideContext(ctx: { tools?: WebMcpTool[] }): Promise<void> {
        tools.clear();
        for (const t of ctx?.tools ?? []) recordTool(t);
      },
      async clearContext(): Promise<void> {
        tools.clear();
      },
    });
    try {
      Object.defineProperty(target, 'modelContext', { value: mc, configurable: true, writable: true });
    } catch {
      // ignore non-configurable host object
    }
  }

  wrapOrInstall(g.document);
  wrapOrInstall(g.navigator);

  Object.defineProperty(g, '__bbWebMcp', {
    configurable: false,
    enumerable: false,
    value: {
      list: () =>
        [...tools.values()].map((t) => ({
          name: t.name,
          kind: 'imperative' as const,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
          readOnlyHint: t.annotations?.readOnlyHint === true,
          consequentialHint: t.annotations?.consequentialHint === true,
        })),
      call: async (name: string, args: Record<string, unknown>, requireReadOnly: boolean) => {
        const tool = tools.get(name);
        if (!tool) return { found: false };
        if (requireReadOnly && tool.annotations?.readOnlyHint !== true) {
          return {
            found: true,
            blockedReadOnly: true,
            error: `WebMCP tool "${name}" is not marked readOnlyHint=true and cannot run in read-only mode.`,
          };
        }
        const value = await tool.execute(args ?? {}, {});
        return { found: true, result: value === undefined ? null : value };
      },
    },
  });

  // Bounded page console & uncaught error ring buffer (zero CDP Runtime.enable detection footprint).
  interface ConsoleEntry {
    seq: number;
    level: 'log' | 'info' | 'warn' | 'error' | 'pageerror';
    text: string;
    timestamp: number;
    url?: string;
    line?: number;
  }

  const MAX_CONSOLE_ENTRIES = 200;
  const consoleBuffer: ConsoleEntry[] = [];
  let consoleSeq = 1;
  const SECRET_TOKEN_RE =
    /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gi;

  function formatArg(val: unknown): string {
    if (val instanceof Error) {
      return val.stack || `${val.name}: ${val.message}`;
    }
    if (typeof val === 'string') return val;
    if (val === null || val === undefined || typeof val === 'number' || typeof val === 'boolean') {
      return String(val);
    }
    try {
      return JSON.stringify(val);
    } catch {
      return Object.prototype.toString.call(val);
    }
  }

  function pushConsole(level: ConsoleEntry['level'], parts: unknown[], url?: string, line?: number): void {
    const raw = parts.map(formatArg).join(' ').replace(SECRET_TOKEN_RE, '[REDACTED]');
    const text = raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw;
    if (consoleBuffer.length >= MAX_CONSOLE_ENTRIES) consoleBuffer.shift();
    consoleBuffer.push({
      seq: consoleSeq++,
      level,
      text,
      timestamp: Date.now(),
      ...(url ? { url } : {}),
      ...(typeof line === 'number' ? { line } : {}),
    });
  }

  const consoleObj = g.console as Record<string, (...args: unknown[]) => void> | undefined;
  if (consoleObj) {
    for (const lvl of ['log', 'info', 'warn', 'error'] as const) {
      const orig = consoleObj[lvl];
      if (typeof orig === 'function') {
        consoleObj[lvl] = function (...args: unknown[]) {
          try {
            pushConsole(lvl, args);
          } catch {
            // never disrupt page execution
          }
          return orig.apply(this, args);
        };
      }
    }
  }

  if (typeof g.addEventListener === 'function') {
    g.addEventListener('error', (ev: ErrorEvent) => {
      try {
        const detail = ev.error instanceof Error ? ev.error : ev.message || 'Uncaught script error';
        pushConsole('pageerror', [detail], ev.filename || undefined, ev.lineno || undefined);
      } catch {
        // ignore
      }
    });
    g.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      try {
        pushConsole('pageerror', ['UnhandledPromiseRejection:', ev.reason]);
      } catch {
        // ignore
      }
    });
  }

  Object.defineProperty(g, '__bbConsole', {
    configurable: false,
    enumerable: false,
    value: {
      read: (level = 'all', limit = 100, clear = false) => {
        const normalized = String(level || 'all').toLowerCase();
        let filtered = consoleBuffer;
        if (normalized === 'error' || normalized === 'errors') {
          filtered = consoleBuffer.filter((e) => e.level === 'error' || e.level === 'pageerror');
        } else if (normalized === 'warn' || normalized === 'warning') {
          filtered = consoleBuffer.filter((e) => e.level === 'warn' || e.level === 'error' || e.level === 'pageerror');
        }
        const max = Math.max(1, Math.min(Number(limit) || 100, 200));
        const entries = filtered.slice(-max);
        const total = consoleBuffer.length;
        if (clear) consoleBuffer.length = 0;
        return { total, entries };
      },
      clear: () => {
        const cleared = consoleBuffer.length;
        consoleBuffer.length = 0;
        return { cleared };
      },
    },
  });
})();
