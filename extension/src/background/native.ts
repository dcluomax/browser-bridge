import { api } from '../shared/api.ts';
import { NATIVE_HOST_NAME, type ExtensionToHost, type HelloMessage, type HostToExtension } from '../shared/protocol.ts';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

const MAX_RETRY_MS = 60_000;

/**
 * Owns the native messaging port. Chromium keeps an MV3 service worker alive while a native port
 * is open; on disconnect we retry with exponential backoff, and an alarm acts as a backstop.
 */
export class NativeConnection {
  status: ConnectionStatus = 'idle';
  lastError = '';
  hostVersion = '';
  pipeName = '';
  agentGuide = '';
  private port: chrome.runtime.Port | null = null;
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onMessage: (message: HostToExtension) => void,
    private readonly onDisconnected: () => void,
    private readonly hello: () => Promise<HelloMessage>,
  ) {}

  get connected(): boolean {
    return this.status === 'connected' && this.port !== null;
  }

  ensureConnected(): void {
    if (!this.port) this.connect();
  }

  reconnect(): void {
    this.retryMs = 1000;
    if (this.port) {
      try {
        this.port.disconnect();
      } catch {
        // ignore
      }
      this.port = null;
      this.onDisconnected();
    }
    this.connect();
  }

  connect(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.port) return;
    this.status = 'connecting';
    let port: chrome.runtime.Port;
    try {
      port = api.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.port = port;
    port.onMessage.addListener((message: HostToExtension) => {
      if (message && message.type === 'hostHello') {
        this.status = 'connected';
        this.lastError = '';
        this.retryMs = 1000;
        this.hostVersion = message.hostVersion;
        this.pipeName = message.pipeName;
        this.agentGuide = message.agentGuide ?? '';
      }
      this.onMessage(message);
    });
    port.onDisconnect.addListener((p: chrome.runtime.Port) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const error = api.runtime.lastError?.message ?? (p as any).error?.message ?? 'The native host closed the connection.';
      if (this.port === port) {
        this.port = null;
        this.onDisconnected();
        this.fail(error);
      }
    });
    void this.hello().then((message) => this.post(message));
  }

  post(message: ExtensionToHost): void {
    if (!this.port) return;
    try {
      this.port.postMessage(message);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private fail(error: string): void {
    this.status = 'error';
    this.lastError = error;
    this.hostVersion = '';
    this.pipeName = '';
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    console.warn(`[browser-bridge] native host connection failed: ${error}; retrying in ${delay} ms`);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
