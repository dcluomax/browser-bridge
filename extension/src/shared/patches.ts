import type { ElementSummary, Locator } from './locators.ts';

export interface PatchTarget {
  ref?: string;
  locator?: Locator;
}

export interface PatchChange {
  target: PatchTarget;
  styles?: Record<string, string | null>;
  attributes?: Record<string, string | null>;
  text?: string;
}

export interface PatchOptions {
  ttlMs?: number;
  label?: string;
}

export interface PatchSummary {
  id: string;
  label?: string;
  createdAt: number;
  expiresAt: number;
  changeCount: number;
  bytes: number;
  targets: ElementSummary[];
  sourceChanged: false;
}

export type PatchErrorCode = 'bad_request' | 'forbidden' | 'patch_conflict' | 'expired' | 'patch_failed';

export interface PatchDiagnostic {
  id: string;
  code: PatchErrorCode;
  message: string;
}

export interface PatchRollbackResult {
  rolledBack: string[];
}

export interface PatchCommitResult {
  id: string;
  committed: true;
  sourceChanged: false;
}

export interface PatchCleanupResult {
  released: string[];
  rolledBack: string[];
  errors: PatchDiagnostic[];
}

export const PATCH_LIMITS = Object.freeze({
  maxChanges: 50,
  maxPayloadBytes: 64 * 1024,
  maxPayloadNodes: 8192,
  maxActivePatches: 32,
  maxHistoryBytes: 1024 * 1024,
  maxInactiveHandles: 128,
  maxProperties: 32,
  maxTextNodes: 128,
  maxScanNodes: 2048,
  defaultTtlMs: 5 * 60 * 1000,
  minTtlMs: 1,
  maxTtlMs: 30 * 60 * 1000,
});
