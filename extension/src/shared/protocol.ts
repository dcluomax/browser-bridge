/** Native messaging host name registered for every supported browser. */
export const NATIVE_HOST_NAME = 'io.github.dcluomax.browser_bridge';

/** Bumped when the extension <-> host message contract changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export type BrowserKind = 'edge' | 'chrome' | 'chromium' | 'firefox' | 'unknown';

/** Extension -> host: identifies this browser profile. Re-sent when the label changes. */
export interface HelloMessage {
  type: 'hello';
  protocol: number;
  browser: BrowserKind;
  browserVersion: string;
  extensionVersion: string;
  instanceId: string;
  label: string;
}

/** Host -> extension: acknowledges hello. */
export interface HostHelloMessage {
  type: 'hostHello';
  protocol: number;
  hostVersion: string;
  pipeName: string;
  agentGuide?: string;
}

/** Host -> extension: an agent session (one MCP server connection) opened or closed. */
export interface SessionMessage {
  type: 'session';
  event: 'open' | 'close';
  session: string;
  client?: { name?: string; pid?: number };
}

/** Host -> extension: a command from an agent session. */
export interface RequestMessage {
  type: 'request';
  id: string;
  session: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

/** Extension -> host: the result of a request. */
export interface ResponseMessage {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ErrorPayload;
}

/** Extension -> host: an asynchronous notification (e.g. shared tab inventory changed). */
export interface EventMessage {
  type: 'event';
  event: string;
  data?: unknown;
}

/** Extension -> host: write a PNG screenshot directly to the user's Downloads folder. */
export interface SaveScreenshotMessage {
  type: 'saveScreenshot';
  id: string;
  title: string;
  fullPage: boolean;
  data: string;
}

/** Host -> extension: confirms screenshot saved to Downloads. */
export interface SavedScreenshotMessage {
  type: 'savedScreenshot';
  id: string;
  ok: boolean;
  fileName?: string;
  path?: string;
  error?: string;
}

/** Extension -> host: persist a user-demonstrated Routine directly into Site Memory. */
export interface SaveDemonstratedRoutineMessage {
  type: 'saveDemonstratedRoutine';
  url: string;
  name: string;
  description: string;
  steps: Array<{ op: string; params: Record<string, unknown> }>;
}

export type HostToExtension = HostHelloMessage | SessionMessage | RequestMessage | SavedScreenshotMessage;
export type ExtensionToHost =
  | HelloMessage
  | ResponseMessage
  | EventMessage
  | SaveScreenshotMessage
  | SaveDemonstratedRoutineMessage;

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
