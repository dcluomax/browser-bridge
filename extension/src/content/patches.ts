import { parseLocator, type ElementSummary } from '../shared/locators.ts';
import {
  PATCH_LIMITS,
  type PatchChange,
  type PatchCleanupResult,
  type PatchCommitResult,
  type PatchDiagnostic,
  type PatchErrorCode,
  type PatchOptions,
  type PatchRollbackResult,
  type PatchSummary,
  type PatchTarget,
} from '../shared/patches.ts';

export { PATCH_LIMITS } from '../shared/patches.ts';
export type {
  PatchChange, PatchCleanupResult, PatchCommitResult, PatchDiagnostic, PatchErrorCode,
  PatchOptions, PatchRollbackResult, PatchSummary, PatchTarget,
} from '../shared/patches.ts';

export interface PatchHelpers {
  resolveTarget(target: PatchTarget | undefined): Element;
  refFor(element: Element): string;
  summarize(element: Element): ElementSummary;
}

export interface PatchApi {
  apply(owner: string, changes: PatchChange[], options?: PatchOptions): PatchSummary;
  list(owner: string): PatchSummary[];
  rollback(owner: string, id?: string): PatchRollbackResult;
  commit(owner: string, id: string): PatchCommitResult;
  releaseOwner(owner: string): PatchCleanupResult;
  dispose(): PatchCleanupResult;
}

export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly errors: PatchDiagnostic[];

  constructor(code: PatchErrorCode, message: string, errors: PatchDiagnostic[] = []) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.errors = errors;
  }
}

interface AttributeState {
  present: boolean;
  value: string | null;
}

interface StyleState extends AttributeState {
  declarations: Array<{ name: string; value: string; priority: string }>;
}

interface TextState {
  nodes: Text[];
  values: string[];
}

interface StyleChange {
  name: string;
  value: string | null;
  priority: string;
}

interface ValidatedChange {
  target: PatchTarget;
  styles: StyleChange[];
  attributes: Array<{ name: string; value: string | null }>;
  text?: string;
}

type Mutation =
  | { kind: 'attribute'; element: HTMLElement; name: string; before: AttributeState; after: AttributeState }
  | { kind: 'style'; element: HTMLElement; change: StyleChange; before: StyleState; after: StyleState }
  | { kind: 'text'; element: HTMLElement; node: Text; before: string; after: string }
  | { kind: 'append'; element: HTMLElement; node: Text; value: string };

interface TargetHistory {
  element: HTMLElement;
  attributes: Array<{ name: string; before: AttributeState; after: AttributeState }>;
  style?: { before: StyleState; after: StyleState };
  text?: { before: TextState; after: TextState };
}

interface PatchEntry {
  owner: string;
  summary: PatchSummary;
  targets: TargetHistory[];
  mutations: Mutation[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

type Direction = 'before' | 'after';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'base', 'title',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'source', 'track',
  'input', 'textarea', 'select', 'option', 'optgroup', 'button', 'form', 'label',
]);
const CONTROL_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox', 'option', 'checkbox',
  'radio', 'switch', 'slider', 'button', 'form',
]);
const SENSITIVE_MARKERS = ['data-sensitive', 'data-private', 'data-secret', 'data-bb-sensitive'];
const SENSITIVE_NAME = /(?:^|[^a-z])(?:password|passwd|pwd|otp|secret|token|mfa|2fa|cvv|cvc|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code|auth[-_ ]?code|credit[-_ ]?card|card[-_ ]?number)(?:$|[^a-z])/i;
const SAFE_ATTRIBUTES = new Set(['class', 'title', 'hidden', 'role', 'lang', 'dir']);
const SAFE_STYLES = new Set([
  'color', 'background-color', 'background', 'background-image', 'background-position',
  'background-size', 'background-repeat', 'background-origin', 'background-clip',
  'opacity', 'display', 'visibility', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'inset', 'inset-block', 'inset-inline', 'inset-block-start', 'inset-block-end',
  'inset-inline-start', 'inset-inline-end', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'inline-size', 'block-size', 'min-inline-size', 'min-block-size',
  'max-inline-size', 'max-block-size', 'box-sizing', 'overflow', 'overflow-x', 'overflow-y',
  'overflow-wrap', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block', 'margin-inline', 'margin-block-start', 'margin-block-end',
  'margin-inline-start', 'margin-inline-end', 'padding', 'padding-top', 'padding-right',
  'padding-bottom', 'padding-left', 'padding-block', 'padding-inline', 'padding-block-start',
  'padding-block-end', 'padding-inline-start', 'padding-inline-end', 'border', 'border-width',
  'border-style', 'border-color', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-block', 'border-inline', 'border-block-start', 'border-block-end',
  'border-inline-start', 'border-inline-end', 'border-block-width', 'border-inline-width',
  'border-block-style', 'border-inline-style', 'border-block-color', 'border-inline-color',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius', 'outline', 'outline-width',
  'outline-style', 'outline-color', 'outline-offset', 'box-shadow', 'text-shadow',
  'font-size', 'font-weight', 'font-style', 'font-family', 'font-variant-caps', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform',
  'text-decoration', 'text-decoration-line', 'text-decoration-style', 'text-decoration-color',
  'text-decoration-thickness', 'text-underline-offset', 'white-space', 'word-break',
  'text-overflow', 'vertical-align', 'direction', 'writing-mode', 'text-orientation',
  'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap',
  'order', 'justify-content', 'justify-items', 'justify-self', 'align-content',
  'align-items', 'align-self', 'gap', 'row-gap', 'column-gap', 'grid-template-columns',
  'grid-template-rows', 'grid-auto-columns', 'grid-auto-rows', 'grid-auto-flow',
  'grid-column', 'grid-column-start', 'grid-column-end', 'grid-row', 'grid-row-start',
  'grid-row-end', 'transform', 'transform-origin', 'translate', 'rotate', 'scale',
  'filter', 'backdrop-filter', 'cursor', 'pointer-events', 'user-select', 'isolation',
  'aspect-ratio', 'object-fit', 'object-position',
]);
const SAFE_FUNCTIONS = new Set([
  'calc', 'min', 'max', 'clamp', 'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch',
  'oklab', 'oklch', 'color', 'color-mix', 'light-dark', 'linear-gradient',
  'radial-gradient', 'conic-gradient', 'repeating-linear-gradient',
  'repeating-radial-gradient', 'repeating-conic-gradient', 'repeat', 'minmax', 'fit-content',
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale',
  'scalex', 'scaley', 'scalez', 'scale3d', 'rotate', 'rotatex', 'rotatey', 'rotatez',
  'rotate3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate',
  'invert', 'opacity', 'saturate', 'sepia',
]);
const GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
]);
const encoder = new TextEncoder();

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PatchError('bad_request', `${label} must be an object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PatchError('bad_request', `${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) {
      throw new PatchError('bad_request', `${label} must contain only plain JSON properties.`);
    }
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PatchError('bad_request', `Unsupported ${label} property "${key}".`);
  }
}

function jsonCopy(value: unknown, depth = 0, budget = { remaining: PATCH_LIMITS.maxPayloadBytes, nodes: 0 }): unknown {
  if (depth > 20) throw new PatchError('bad_request', 'Patch payload nesting is too deep.');
  if (++budget.nodes > PATCH_LIMITS.maxPayloadNodes) throw new PatchError('bad_request', 'Patch payload contains too many values.');
  function consume(text: string): void {
    if (text.length > PATCH_LIMITS.maxPayloadBytes) throw new PatchError('bad_request', 'Patch payload exceeds the 64 KiB limit.');
    budget.remaining -= bytes(text);
    if (budget.remaining < 0) throw new PatchError('bad_request', 'Patch payload exceeds the 64 KiB limit.');
  }
  if (value === null || typeof value === 'boolean') {
    consume(String(value));
    return value;
  }
  if (typeof value === 'string') {
    consume(value);
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    consume(String(value));
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new PatchError('bad_request', 'Patch payload array is too large.');
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw new PatchError('bad_request', 'Patch arrays require plain JSON values.');
      output.push(jsonCopy(descriptor.value as unknown, depth + 1, budget));
    }
    return output;
  }
  const input = object(value, 'patch payload');
  if (Object.keys(input).length > 64) throw new PatchError('bad_request', 'Patch payload object is too large.');
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(input)) {
    consume(key);
    output[key] = item === undefined ? undefined : jsonCopy(item, depth + 1, budget);
  }
  return output;
}

function validateOwner(owner: string): void {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 256) {
    throw new PatchError('bad_request', 'Patch owner must be a non-empty session identifier of at most 256 characters.');
  }
}

function parseTarget(value: unknown): PatchTarget {
  const target = object(value, 'patch target');
  keys(target, ['ref', 'locator'], 'patch target');
  if ((target.ref !== undefined) === (target.locator !== undefined)) {
    throw new PatchError('bad_request', 'Each patch target must contain exactly one ref or locator.');
  }
  if (target.ref !== undefined) {
    if (typeof target.ref !== 'string' || !target.ref.trim() || target.ref.length > 256) {
      throw new PatchError('bad_request', 'Patch target ref must be a non-empty string of at most 256 characters.');
    }
    return { ref: target.ref };
  }
  try {
    return { locator: parseLocator(jsonCopy(target.locator)) };
  } catch (error) {
    throw new PatchError('bad_request', error instanceof Error ? error.message : 'Invalid patch locator.');
  }
}

function parseStyle(name: string, value: unknown): StyleChange {
  if (!SAFE_STYLES.has(name)) throw new PatchError('forbidden', `Style property "${name}" is not permitted in page patches.`);
  if (value === null) return { name, value, priority: '' };
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new PatchError('bad_request', 'Style values must be non-empty strings of at most 4096 characters, or null.');
  }
  const important = /\s*!important\s*$/i;
  const priority = important.test(value) ? 'important' : '';
  const declaration = value.replace(important, '').trim();
  if (!declaration || /[\\;{}<>!\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(declaration) ||
      /\/\*|\*\/|@|(?:https?|data|javascript|vbscript):/i.test(declaration)) {
    throw new PatchError('forbidden', 'CSS escapes, URLs, executable values, and additional declarations are not permitted.');
  }
  for (const match of declaration.matchAll(/([a-z][a-z0-9-]*)\s*\(/gi)) {
    if (!SAFE_FUNCTIONS.has(match[1].toLowerCase())) {
      throw new PatchError('forbidden', `CSS function "${match[1]}" is not permitted in page patches.`);
    }
  }
  if (['background', 'background-image', 'filter', 'backdrop-filter', 'cursor'].includes(name) &&
      /^(?:inherit|revert|revert-layer|unset)$/i.test(declaration)) {
    throw new PatchError('forbidden', 'URL-capable styles cannot inherit or restore an indirect page-defined resource.');
  }
  if (name === 'font-family' && declaration.split(',').some((font) => !GENERIC_FONTS.has(font.trim().toLowerCase()))) {
    throw new PatchError('forbidden', 'Page patches can use only generic font families, not downloadable fonts.');
  }
  return { name, value: declaration, priority };
}

function parseChanges(value: unknown): ValidatedChange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PATCH_LIMITS.maxChanges) {
    throw new PatchError('bad_request', `A patch must contain 1-${PATCH_LIMITS.maxChanges} changes.`);
  }
  return value.map((input: unknown): ValidatedChange => {
    const change = object(input, 'patch change');
    keys(change, ['target', 'styles', 'attributes', 'text'], 'patch change');
    const target = parseTarget(change.target);
    const styles: StyleChange[] = [];
    const attributes: Array<{ name: string; value: string | null }> = [];
    if (change.styles !== undefined) {
      const inputStyles = object(change.styles, 'styles');
      if (Object.keys(inputStyles).length > PATCH_LIMITS.maxProperties) {
        throw new PatchError('bad_request', 'Too many style properties in one patch change.');
      }
      for (const [name, value] of Object.entries(inputStyles)) styles.push(parseStyle(name, value));
    }
    if (change.attributes !== undefined) {
      const inputAttributes = object(change.attributes, 'attributes');
      if (Object.keys(inputAttributes).length > PATCH_LIMITS.maxProperties) {
        throw new PatchError('bad_request', 'Too many attributes in one patch change.');
      }
      for (const [name, value] of Object.entries(inputAttributes)) {
        if (!SAFE_ATTRIBUTES.has(name) && !/^(?:aria|data)-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
          throw new PatchError('forbidden', `Attribute "${name}" is not permitted in page patches.`);
        }
        if (value !== null && (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) {
          throw new PatchError('bad_request', 'Attribute values must be plain strings or null.');
        }
        if (name === 'hidden' && value !== null && value !== '' && value !== 'hidden') {
          throw new PatchError('bad_request', 'hidden must be an empty string, "hidden", or null.');
        }
        if (name === 'dir' && value !== null && !['ltr', 'rtl', 'auto'].includes(value)) {
          throw new PatchError('bad_request', 'dir must be ltr, rtl, auto, or null.');
        }
        attributes.push({ name, value: value as string | null });
      }
    }
    if (change.text !== undefined && typeof change.text !== 'string') {
      throw new PatchError('bad_request', 'Patch text must be a plain string.');
    }
    if (!styles.length && !attributes.length && change.text === undefined) {
      throw new PatchError('bad_request', 'Each patch change must set styles, attributes, or leaf text.');
    }
    return { target, styles, attributes, ...(change.text !== undefined ? { text: change.text as string } : {}) };
  });
}

function parseOptions(value: unknown): Required<Pick<PatchOptions, 'ttlMs'>> & Pick<PatchOptions, 'label'> {
  const options = value === undefined ? {} : object(value, 'patch options');
  keys(options, ['ttlMs', 'label'], 'patch options');
  const ttlMs = options.ttlMs === undefined ? PATCH_LIMITS.defaultTtlMs : options.ttlMs;
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < PATCH_LIMITS.minTtlMs || ttlMs > PATCH_LIMITS.maxTtlMs) {
    throw new PatchError('bad_request', `ttlMs must be an integer from ${PATCH_LIMITS.minTtlMs} to ${PATCH_LIMITS.maxTtlMs}.`);
  }
  if (options.label !== undefined && (typeof options.label !== 'string' || options.label.length > 128)) {
    throw new PatchError('bad_request', 'Patch label must be a string of at most 128 characters.');
  }
  return { ttlMs, ...(options.label !== undefined ? { label: options.label as string } : {}) };
}

function attributeState(element: Element, name: string): AttributeState {
  return { present: element.hasAttribute(name), value: element.getAttribute(name) };
}

function styleState(element: HTMLElement): StyleState {
  const declarations: StyleState['declarations'] = [];
  for (let index = 0; index < element.style.length; index++) {
    const name = element.style.item(index);
    declarations.push({ name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) });
  }
  return { ...attributeState(element, 'style'), declarations };
}

function equalAttribute(left: AttributeState, right: AttributeState): boolean {
  return left.present === right.present && left.value === right.value;
}

function equalStyle(left: StyleState, right: StyleState): boolean {
  return equalAttribute(left, right) && left.declarations.length === right.declarations.length &&
    left.declarations.every((declaration, index) => {
      const other = right.declarations[index];
      return declaration.name === other.name && declaration.value === other.value && declaration.priority === other.priority;
    });
}

function equalText(element: Element, state: TextState): boolean {
  return element.childNodes.length === state.nodes.length &&
    state.nodes.every((node, index) => element.childNodes[index] === node && node.data === state.values[index]);
}

function writeAttribute(element: Element, name: string, state: AttributeState): void {
  if (state.present) element.setAttribute(name, state.value ?? '');
  else element.removeAttribute(name);
}

function writeStyle(element: HTMLElement, change: StyleChange): void {
  if (change.value === null) element.style.removeProperty(change.name);
  else element.style.setProperty(change.name, change.value, change.priority);
}

function composedParent(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root.nodeType === 11 && 'host' in root ? (root as ShadowRoot).host : null;
}

function sensitive(element: Element): boolean {
  if (SENSITIVE_MARKERS.some((name) => element.hasAttribute(name))) return true;
  const editable = element.getAttribute('contenteditable');
  if (editable !== null && editable.toLowerCase() !== 'false') return true;
  if ((element.getAttribute('role') ?? '').toLowerCase().split(/\s+/).some((role) => CONTROL_ROLES.has(role))) return true;
  const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  if (autocomplete.some((token) => ['current-password', 'new-password', 'one-time-code'].includes(token) || token.startsWith('cc-'))) return true;
  if ((element.getAttribute('type') ?? '').toLowerCase() === 'password') return true;
  return ['id', 'name', 'aria-label'].some((name) => SENSITIVE_NAME.test(element.getAttribute(name) ?? ''));
}

function assertPatchable(element: Element): asserts element is HTMLElement {
  if (element.namespaceURI !== HTML_NAMESPACE || FORBIDDEN_TAGS.has(element.localName) ||
      element.localName.includes('-') || element.hasAttribute('is')) {
    throw new PatchError('forbidden', 'Page patches require an ordinary HTML element, not executable content or a form control.');
  }
  let count = 0;
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (++count > PATCH_LIMITS.maxScanNodes) throw new PatchError('bad_request', 'Patch ancestor traversal limit exceeded.');
    if (FORBIDDEN_TAGS.has(current.localName) || sensitive(current)) {
      throw new PatchError('forbidden', 'Page patches cannot modify sensitive, editable, or form regions.');
    }
  }
  if (element.children.length > PATCH_LIMITS.maxScanNodes) throw new PatchError('bad_request', 'Patch sensitive-region scan limit exceeded.');
  const pending = Array.from(element.children);
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    if (++count > PATCH_LIMITS.maxScanNodes) throw new PatchError('bad_request', 'Patch sensitive-region scan limit exceeded.');
    if (sensitive(current)) throw new PatchError('forbidden', 'Patch target contains a sensitive or editable region.');
    if (pending.length + count + current.children.length + (current.shadowRoot?.children.length ?? 0) > PATCH_LIMITS.maxScanNodes) {
      throw new PatchError('bad_request', 'Patch sensitive-region scan limit exceeded.');
    }
    pending.push(...Array.from(current.children));
    if (current.shadowRoot) pending.push(...Array.from(current.shadowRoot.children));
  }
  if (element.shadowRoot) {
    throw new PatchError('forbidden', 'Patch targets with a shadow root are not supported.');
  }
}

function ancestorOf(ancestor: Element, element: Element): boolean {
  let count = 0;
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current === ancestor) return true;
    if (++count > PATCH_LIMITS.maxScanNodes) throw new PatchError('bad_request', 'Patch overlap traversal limit exceeded.');
  }
  return false;
}

function attributeBytes(state: AttributeState): number {
  return 32 + bytes(state.value ?? '');
}

function styleBytes(state: StyleState): number {
  return attributeBytes(state) + state.declarations.reduce((sum, item) => sum + 64 + bytes(item.name) + bytes(item.value) + bytes(item.priority), 0);
}

function mutationBytes(mutation: Mutation): number {
  switch (mutation.kind) {
    case 'attribute': return 128 + bytes(mutation.name) + attributeBytes(mutation.before) + attributeBytes(mutation.after);
    case 'style': return 128 + bytes(mutation.change.name) + bytes(mutation.change.value ?? '') + styleBytes(mutation.before) + styleBytes(mutation.after);
    case 'text': return 128 + bytes(mutation.before) + bytes(mutation.after);
    case 'append': return 128 + bytes(mutation.value);
  }
}

function planTarget(element: HTMLElement, change: ValidatedChange, doc: Document): { target: TargetHistory; mutations: Mutation[] } {
  const target: TargetHistory = { element, attributes: [] };
  const mutations: Mutation[] = [];
  if (change.styles.length) {
    const original = styleState(element);
    if (styleBytes(original) > PATCH_LIMITS.maxHistoryBytes) throw new PatchError('bad_request', 'Original inline style exceeds the patch history limit.');
    const stage = doc.createElement('div');
    writeAttribute(stage, 'style', original);
    for (const style of change.styles) {
      if (style.value !== null) {
        const validator = doc.createElement('div');
        writeStyle(validator, style);
        if (!validator.style.getPropertyValue(style.name) || validator.style.getPropertyPriority(style.name) !== style.priority) {
          throw new PatchError('bad_request', `Invalid or unsupported CSS declaration for "${style.name}".`);
        }
      }
      const before = styleState(stage);
      writeStyle(stage, style);
      const after = styleState(stage);
      mutations.push({ kind: 'style', element, change: style, before, after });
    }
    target.style = { before: original, after: styleState(stage) };
  }
  for (const { name, value } of change.attributes) {
    const before = attributeState(element, name);
    const after = { present: value !== null, value };
    target.attributes.push({ name, before, after });
    mutations.push({ kind: 'attribute', element, name, before, after });
  }
  if (change.text !== undefined) {
    if (element.childNodes.length > PATCH_LIMITS.maxTextNodes || Array.from(element.childNodes).some((node) => node.nodeType !== 3)) {
      throw new PatchError('forbidden', 'Text patches require a plain-text leaf with no child elements or other node types.');
    }
    const nodes = Array.from(element.childNodes) as Text[];
    const before: TextState = { nodes, values: nodes.map((node) => node.data) };
    if (nodes.length) {
      const values = nodes.map((_node, index) => index === 0 ? change.text ?? '' : '');
      for (let index = 0; index < nodes.length; index++) {
        mutations.push({ kind: 'text', element, node: nodes[index], before: before.values[index], after: values[index] });
      }
      target.text = { before, after: { nodes, values } };
    } else {
      const node = doc.createTextNode(change.text);
      mutations.push({ kind: 'append', element, node, value: change.text });
      target.text = { before, after: { nodes: [node], values: [change.text] } };
    }
  }
  return { target, mutations };
}

function copySummary(summary: PatchSummary): PatchSummary {
  return { ...summary, targets: summary.targets.map((target) => ({ ...target })) };
}

function errorCode(error: unknown): PatchErrorCode {
  if (error && typeof error === 'object' && 'code' in error &&
      ['bad_request', 'forbidden', 'patch_conflict', 'expired', 'patch_failed'].includes(String(error.code))) {
    return error.code as PatchErrorCode;
  }
  return 'patch_failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'DOM patch operation failed.';
}

export function createPatchApi(helpers: PatchHelpers): PatchApi {
  const doc = document;
  const root = doc.documentElement;
  const entries = new Map<string, PatchEntry>();
  const inactive = new Map<string, string>();
  let retainedBytes = 0;
  let disposed = false;
  let busy = false;

  function assertDocument(): void {
    if (document !== doc || doc.documentElement !== root || !root?.isConnected) {
      throw new PatchError('expired', 'Patch handles belong to a replaced document. Take new references; patches are never replayed.');
    }
  }

  function assertConnected(element: Element): void {
    assertDocument();
    if (element.ownerDocument !== doc || !element.isConnected) {
      throw new PatchError('patch_conflict', 'A patch target is detached or belongs to another document. It will not be re-resolved.');
    }
  }

  function exclusive<T>(operation: () => T, allowDisposed = false): T {
    if (busy) throw new PatchError('patch_conflict', 'A DOM patch transaction is already running.');
    if (disposed && !allowDisposed) throw new PatchError('expired', 'This document patch API has been disposed.');
    busy = true;
    try {
      return operation();
    } catch (error) {
      if (error instanceof PatchError) throw error;
      throw new PatchError(errorCode(error), errorMessage(error));
    } finally {
      busy = false;
    }
  }

  function assertTargetState(target: TargetHistory, direction: Direction): void {
    assertConnected(target.element);
    if (target.attributes.some((attribute) => !equalAttribute(attributeState(target.element, attribute.name), attribute[direction])) ||
        (target.style && !equalStyle(styleState(target.element), target.style[direction])) ||
        (target.text && !equalText(target.element, target.text[direction]))) {
      throw new PatchError('patch_conflict', 'The page changed a patched value or text node. Rollback would overwrite application changes.');
    }
  }

  function mutationMatches(mutation: Mutation, direction: Direction): boolean {
    switch (mutation.kind) {
      case 'attribute': return equalAttribute(attributeState(mutation.element, mutation.name), mutation[direction]);
      case 'style': return equalStyle(styleState(mutation.element), mutation[direction]);
      case 'text': return mutation.node.parentNode === mutation.element && mutation.node.data === mutation[direction];
      case 'append': return direction === 'before'
        ? mutation.element.childNodes.length === 0 && mutation.node.parentNode === null && mutation.node.data === mutation.value
        : mutation.element.childNodes.length === 1 && mutation.element.firstChild === mutation.node && mutation.node.data === mutation.value;
    }
  }

  function writeMutation(mutation: Mutation, direction: Direction): void {
    switch (mutation.kind) {
      case 'attribute': writeAttribute(mutation.element, mutation.name, mutation[direction]); break;
      case 'style':
        if (direction === 'after') writeStyle(mutation.element, mutation.change);
        else writeAttribute(mutation.element, 'style', mutation.before);
        break;
      case 'text': mutation.node.data = mutation[direction]; break;
      case 'append':
        if (direction === 'after') mutation.element.appendChild(mutation.node);
        else mutation.element.removeChild(mutation.node);
        break;
    }
  }

  function transaction(mutations: Mutation[], direction: Direction, id: string, finish?: () => void): void {
    const source: Direction = direction === 'after' ? 'before' : 'after';
    const attempted: Mutation[] = [];
    try {
      for (const mutation of mutations) {
        assertConnected(mutation.element);
        if (!mutationMatches(mutation, source)) throw new PatchError('patch_conflict', 'A page value changed during the patch transaction.');
        attempted.push(mutation);
        writeMutation(mutation, direction);
        if (!mutationMatches(mutation, direction)) throw new PatchError('patch_conflict', 'The page changed a value during the patch transaction.');
      }
      finish?.();
    } catch (error) {
      const errors: PatchDiagnostic[] = [];
      for (const mutation of attempted.reverse()) {
        try {
          assertConnected(mutation.element);
          if (mutationMatches(mutation, source)) continue;
          if (!mutationMatches(mutation, direction)) {
            throw new PatchError('patch_conflict', 'Transaction recovery refused to overwrite an application change.');
          }
          writeMutation(mutation, source);
          if (!mutationMatches(mutation, source)) throw new PatchError('patch_conflict', 'The page changed a value during transaction recovery.');
        } catch (recoveryError) {
          errors.push({ id, code: errorCode(recoveryError), message: errorMessage(recoveryError) });
        }
      }
      throw new PatchError(errorCode(error), `${errorMessage(error)} ${errors.length ? 'Transaction recovery was incomplete; inspect the reported errors.' : 'The transaction was reversed.'}`, errors);
    }
  }

  function forget(entry: PatchEntry): void {
    if (!entries.delete(entry.summary.id)) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    retainedBytes -= entry.summary.bytes;
    inactive.set(entry.summary.id, entry.owner);
    while (inactive.size > PATCH_LIMITS.maxInactiveHandles) {
      const oldest = inactive.keys().next().value;
      if (oldest !== undefined) inactive.delete(oldest);
    }
  }

  function rollbackEntries(selected: PatchEntry[]): PatchRollbackResult {
    for (const entry of selected) {
      for (const target of entry.targets) assertTargetState(target, 'after');
    }
    const mutations = selected.flatMap((entry) => [...entry.mutations].reverse());
    transaction(mutations, 'before', selected[0]?.summary.id ?? '', () => {
      for (const entry of selected) {
        for (const target of entry.targets) assertTargetState(target, 'before');
      }
    });
    const rolledBack = selected.map((entry) => entry.summary.id);
    for (const entry of selected) forget(entry);
    return { rolledBack };
  }

  function cleanup(selected: PatchEntry[]): PatchCleanupResult {
    const result: PatchCleanupResult = { released: [], rolledBack: [], errors: [] };
    for (const entry of selected) {
      try {
        rollbackEntries([entry]);
        result.rolledBack.push(entry.summary.id);
      } catch (error) {
        result.errors.push({ id: entry.summary.id, code: errorCode(error), message: errorMessage(error) });
        if (error instanceof PatchError) result.errors.push(...error.errors);
      } finally {
        forget(entry);
        result.released.push(entry.summary.id);
      }
    }
    return result;
  }

  function expire(entry: PatchEntry): void {
    const result = cleanup([entry]);
    for (const error of result.errors) {
      console.error(`[Browser Bridge patches] Expiry rollback failed for ${error.id} (${error.code}): ${error.message}`);
    }
  }

  function owned(owner: string, id: string): PatchEntry {
    if (typeof id !== 'string' || !id || id.length > 128) throw new PatchError('bad_request', 'A valid patch id is required.');
    const entry = entries.get(id);
    if ((entry && entry.owner !== owner) || (inactive.has(id) && inactive.get(id) !== owner)) {
      throw new PatchError('forbidden', 'This patch handle is not owned by this session.');
    }
    if (!entry) throw new PatchError('expired', 'This patch handle is unknown or no longer active in this document.');
    if (entry.summary.expiresAt <= Date.now()) {
      throw new PatchError('expired', 'This patch handle has expired.');
    }
    return entry;
  }

  function ownerEntries(owner: string): PatchEntry[] {
    return [...entries.values()].filter((entry) => entry.owner === owner).reverse();
  }

  function summarize(element: Element): ElementSummary {
    const ref = helpers.refFor(element);
    if (!ref || ref.length > 128) throw new PatchError('bad_request', 'Patch helpers must return a bounded element reference.');
    const summary = helpers.summarize(element);
    return {
      ref, tag: summary.tag.slice(0, 64), role: summary.role === null ? null : summary.role.slice(0, 128), name: summary.name.slice(0, 512),
      text: summary.text.slice(0, 512), visible: summary.visible, enabled: summary.enabled,
      editable: summary.editable, checked: summary.checked,
    };
  }

  return {
    apply(owner: string, input: PatchChange[], inputOptions?: PatchOptions): PatchSummary {
      validateOwner(owner);
      return exclusive(() => {
        assertDocument();
        const payload = object(jsonCopy({ changes: input, options: inputOptions === undefined ? {} : inputOptions }), 'patch payload');
        const payloadBytes = bytes(JSON.stringify(payload));
        if (payloadBytes > PATCH_LIMITS.maxPayloadBytes) throw new PatchError('bad_request', 'Patch payload exceeds the 64 KiB limit.');
        const changes = parseChanges(payload.changes);
        const options = parseOptions(payload.options);
        if (entries.size >= PATCH_LIMITS.maxActivePatches) throw new PatchError('bad_request', 'This document has reached its active patch limit.');

        const elements = changes.map((change) => {
          try {
            return helpers.resolveTarget(change.target);
          } catch (error) {
            throw new PatchError(errorCode(error) === 'patch_failed' ? 'bad_request' : errorCode(error), errorMessage(error));
          }
        });
        const unique = new Set<Element>();
        for (const element of elements) {
          assertConnected(element);
          assertPatchable(element);
          if (unique.has(element)) throw new PatchError('bad_request', 'A patch cannot target the same element more than once.');
          unique.add(element);
          for (const entry of entries.values()) {
            if (entry.targets.some((target) => ancestorOf(target.element, element) || ancestorOf(element, target.element))) {
              throw new PatchError('patch_conflict', 'Overlapping or nested active patches are not supported. Roll back or commit the earlier patch first.');
            }
          }
        }
        const planned = elements.map((element, index) => planTarget(element as HTMLElement, changes[index], doc));
        const targets = planned.map((plan) => plan.target);
        const mutations = planned.flatMap((plan) => plan.mutations);
        const historyBytes = payloadBytes + targets.length * 8192 + mutations.reduce((sum, mutation) => sum + mutationBytes(mutation), 0);
        if (retainedBytes + historyBytes > PATCH_LIMITS.maxHistoryBytes) {
          throw new PatchError('bad_request', 'This document has reached its retained patch history byte limit.');
        }
        for (const target of targets) assertTargetState(target, 'before');
        if (!globalThis.crypto?.getRandomValues) throw new PatchError('bad_request', 'Cryptographic patch handles are unavailable.');
        let id = '';
        for (let attempt = 0; attempt < 8; attempt++) {
          const random = crypto.getRandomValues(new Uint8Array(24));
          id = `p_${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
          if (!entries.has(id) && !inactive.has(id)) break;
          id = '';
        }
        if (!id) throw new PatchError('bad_request', 'Could not allocate a unique cryptographic patch handle.');
        const createdAt = Date.now();
        const summary: PatchSummary = {
          id, ...('label' in options ? { label: options.label } : {}),
          createdAt, expiresAt: createdAt + options.ttlMs, changeCount: changes.length,
          bytes: historyBytes, targets: [], sourceChanged: false,
        };
        const entry: PatchEntry = { owner, summary, targets, mutations, timer: undefined };
        entry.timer = setTimeout(() => {
          if (entries.get(id) !== entry) return;
          exclusive(() => expire(entry), true);
        }, options.ttlMs);
        try {
          transaction(mutations, 'after', id, () => {
            summary.targets = elements.map((element) => summarize(element));
            for (const target of targets) assertTargetState(target, 'after');
          });
        } catch (error) {
          clearTimeout(entry.timer);
          throw error;
        }
        entries.set(id, entry);
        retainedBytes += historyBytes;
        return copySummary(summary);
      });
    },

    list(owner: string): PatchSummary[] {
      validateOwner(owner);
      return exclusive(() => {
        assertDocument();
        return [...entries.values()].filter((entry) => entry.owner === owner && entry.summary.expiresAt > Date.now()).map((entry) => copySummary(entry.summary));
      });
    },

    rollback(owner: string, id?: string): PatchRollbackResult {
      validateOwner(owner);
      return exclusive(() => {
        assertDocument();
        const selected = id === undefined ? ownerEntries(owner) : [owned(owner, id)];
        if (selected.some((entry) => entry.summary.expiresAt <= Date.now())) {
          throw new PatchError('expired', 'A selected patch handle has expired. Expiry cleanup runs separately.');
        }
        return rollbackEntries(selected);
      });
    },

    commit(owner: string, id: string): PatchCommitResult {
      validateOwner(owner);
      return exclusive(() => {
        assertDocument();
        const entry = owned(owner, id);
        forget(entry);
        return { id, committed: true, sourceChanged: false };
      });
    },

    releaseOwner(owner: string): PatchCleanupResult {
      validateOwner(owner);
      return exclusive(() => cleanup(ownerEntries(owner)), true);
    },

    dispose(): PatchCleanupResult {
      return exclusive(() => {
        const result = cleanup([...entries.values()].reverse());
        disposed = true;
        inactive.clear();
        return result;
      }, true);
    },
  };
}
