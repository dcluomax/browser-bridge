export type LocatorStep =
  | { kind: 'css' | 'text' | 'label' | 'placeholder' | 'testId' | 'altText' | 'title'; value: string; exact?: boolean }
  | { kind: 'role'; value: string; name?: string; exact?: boolean; includeHidden?: boolean }
  | { kind: 'nth'; index: number }
  | { kind: 'filter'; value: string };

export interface Locator {
  steps: LocatorStep[];
  frameId?: number;
}

export interface ElementSummary {
  ref: string;
  tag: string;
  role: string | null;
  name: string;
  text: string;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  checked: boolean | null;
}

export interface LocatedElements {
  count: number;
  elements: ElementSummary[];
  truncated: boolean;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported ${label} property "${key}".`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error(`${label} must be a non-empty string of at most 4096 characters.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

export function parseLocator(value: unknown): Locator {
  const locator = object(value, 'locator');
  keys(locator, ['steps', 'frameId'], 'locator');
  if (!Array.isArray(locator.steps) || locator.steps.length === 0 || locator.steps.length > 16) {
    throw new Error('locator.steps must contain 1-16 steps.');
  }
  if (locator.frameId !== undefined && (typeof locator.frameId !== 'number' || !Number.isSafeInteger(locator.frameId) || locator.frameId < 0)) {
    throw new Error('locator.frameId must be a non-negative integer.');
  }
  const steps = locator.steps.map((value, index): LocatorStep => {
    const step = object(value, `locator.steps[${index}]`);
    const kind = step.kind;
    if (kind === 'nth') {
      keys(step, ['kind', 'index'], 'nth step');
      if (index === 0 || typeof step.index !== 'number' || !Number.isSafeInteger(step.index) || step.index < -1) {
        throw new Error('An nth step must follow a finder and have an integer index >= 0 (or -1 for last).');
      }
      return { kind, index: step.index };
    }
    if (kind === 'filter') {
      keys(step, ['kind', 'value'], 'filter step');
      if (index === 0) throw new Error('A filter step must follow a finder.');
      return { kind, value: string(step.value, 'filter value') };
    }
    const supported = ['css', 'role', 'text', 'label', 'placeholder', 'testId', 'altText', 'title'];
    if (typeof kind !== 'string' || !supported.includes(kind)) throw new Error(`Unsupported locator kind "${String(kind)}".`);
    keys(step, kind === 'role' ? ['kind', 'value', 'name', 'exact', 'includeHidden'] : ['kind', 'value', 'exact'], `${kind} step`);
    const text = string(step.value, 'locator value');
    const exact = optionalBoolean(step.exact, 'exact');
    if (kind === 'css' || kind === 'testId') {
      if (exact !== undefined) throw new Error(`The ${kind} finder does not accept exact.`);
      return { kind, value: text };
    }
    if (kind === 'role') {
      if (step.name !== undefined && (typeof step.name !== 'string' || step.name.length > 4096)) throw new Error('role name must be a string of at most 4096 characters.');
      return { kind, value: text, name: step.name, exact, includeHidden: optionalBoolean(step.includeHidden, 'includeHidden') };
    }
    switch (kind) {
      case 'text': case 'label': case 'placeholder': case 'altText': case 'title':
        return { kind, value: text, exact };
      default: throw new Error(`Unsupported locator kind "${kind}".`);
    }
  });
  return { steps, frameId: locator.frameId as number | undefined };
}
