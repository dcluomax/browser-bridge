export interface ReleaseVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseReleaseVersion(value: unknown): ReleaseVersion | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const [major, minor, patch] = value.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch };
}

export function majorMinorMatch(extensionVersion: unknown, nativeVersion: unknown): boolean {
  const extension = parseReleaseVersion(extensionVersion);
  const native = parseReleaseVersion(nativeVersion);
  return extension !== null && native !== null && extension.major === native.major && extension.minor === native.minor;
}

export function versionMismatchWarning(extensionVersion: unknown, nativeVersion: unknown): string | null {
  if (!parseReleaseVersion(extensionVersion) || !parseReleaseVersion(nativeVersion)) {
    return 'Browser Bridge could not verify the extension and native host versions.';
  }
  if (majorMinorMatch(extensionVersion, nativeVersion)) return null;
  return `Browser Bridge extension ${extensionVersion} does not match native host ${nativeVersion}. Update both components, then reload the extension.`;
}
