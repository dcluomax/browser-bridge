/*
 * Content script injected on demand into agent-controlled frames. It is idempotent and keeps
 * per-document element references (`e1`, `e2`, ...) that stay stable across snapshots of the
 * same document. The background script calls into `globalThis.__bb` through
 * scripting.executeScript, so every entry point returns structured-clone friendly data.
 */
import { parseKeyCombo, producesText, type KeyPress } from '../shared/keys.ts';
import { parseLocator, type ElementSummary, type LocatedElements, type Locator, type LocatorStep } from '../shared/locators.ts';

const CONTENT_VERSION = '0.12.0';

interface SnapshotOptions {
  maxChars?: number;
  root?: string;
  viewportOnly?: boolean;
}

interface SnapshotResult {
  text: string;
  truncated: boolean;
  omittedNodes: number;
  visibleIframes: number;
  url: string;
  title: string;
  isTop: boolean;
  width: number;
  height: number;
}

interface SNode {
  role: string;
  name: string;
  ref?: string;
  attrs: string[];
  value?: string;
  children: Array<SNode | string>;
}

interface WalkContext {
  viewportOnly: boolean;
  parentCursor: string;
  insideInteractive: boolean;
  hidden: boolean;
  active: Element | null;
}

interface PointResult {
  x: number;
  y: number;
  covered: string | null;
}

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'base', 'title', 'param', 'source', 'track', 'datalist',
  'defs', 'clippath', 'lineargradient', 'radialgradient', 'pattern', 'marker', 'mask', 'filter', 'symbol',
]);
const NAME_FROM_CONTENT = new Set([
  'button', 'link', 'heading', 'option', 'cell', 'columnheader', 'rowheader', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'treeitem', 'checkbox', 'radio', 'switch', 'tooltip', 'gridcell', 'caption', 'legend', 'shape',
]);
const INTERACTIVE = new Set([
  'link', 'button', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'slider',
  'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'gridcell', 'iframe', 'canvas',
  'video', 'audio', 'scrollbar', 'shape',
]);
const LEAF_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'slider', 'img', 'separator', 'progressbar', 'meter', 'iframe', 'canvas', 'video', 'audio', 'shape']);
const PRUNABLE = new Set(['generic', 'group', 'list', 'listitem', 'row', 'rowgroup', 'cell', 'region', 'paragraph', 'blockquote', 'code', 'figure', 'article', 'complementary', 'navigation', 'banner', 'contentinfo', 'main', 'form', 'table', 'term', 'definition']);
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
/** Inputs without a text caret; typing into them assigns the value directly. */
const VALUE_INPUT_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);

// ---------------------------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------------------------

interface RefDescriptor {
  href: string;
  tag: string;
  testId: string | null;
  id: string | null;
  role: string | null;
  name: string;
}

const elementToRef = new WeakMap<Element, string>();
const refToElement = new Map<string, WeakRef<Element>>();
const refMeta = new Map<string, RefDescriptor>();
const MAX_REF_META = 2500;
let nextRef = 1;

function recordRefMeta(ref: string, el: Element): void {
  const role = computeRole(el);
  const name = role && role !== 'generic' ? accessibleName(el, role, 120) : '';
  const id = el.id && !/^\d|[:\s]/.test(el.id) && el.id.length <= 48 ? el.id : null;
  refMeta.set(ref, {
    href: location.href,
    tag: el.localName,
    testId: attr(el, 'data-testid'),
    id,
    role,
    name,
  });
  if (refMeta.size > MAX_REF_META) {
    const oldest = refMeta.keys().next().value;
    if (oldest !== undefined) refMeta.delete(oldest);
  }
}

function refFor(el: Element): string {
  let ref = elementToRef.get(el);
  if (!ref) {
    ref = `e${nextRef++}`;
    elementToRef.set(el, ref);
    refToElement.set(ref, new WeakRef(el));
    recordRefMeta(ref, el);
  } else if (!refToElement.has(ref)) {
    refToElement.set(ref, new WeakRef(el));
    recordRefMeta(ref, el);
  }
  return ref;
}

function healDetachedRef(ref: string): Element | null {
  const meta = refMeta.get(ref);
  if (!meta || meta.href !== location.href) return null;
  const candidates: Locator[] = [];
  if (meta.testId) {
    candidates.push({ steps: [{ kind: 'testId', value: meta.testId }] });
  }
  if (meta.id) {
    candidates.push({ steps: [{ kind: 'css', value: `#${CSS.escape(meta.id)}` }] });
  }
  if (meta.role && meta.role !== 'generic' && meta.name) {
    candidates.push({ steps: [{ kind: 'role', value: meta.role, name: meta.name, exact: true }] });
  }
  for (const cand of candidates) {
    try {
      const matches = findElements(cand).filter((m) => m.isConnected && m.localName === meta.tag);
      if (matches.length === 1) {
        const healed = matches[0];
        elementToRef.set(healed, ref);
        refToElement.set(ref, new WeakRef(healed));
        return healed;
      }
    } catch {
      // ignore invalid selector edge cases
    }
  }
  return null;
}

function resolve(ref: string): Element {
  const el = refToElement.get(ref)?.deref();
  if (el && el.isConnected) return el;
  refToElement.delete(ref);
  const healed = healDetachedRef(ref);
  if (healed) return healed;
  throw new Error(`Element ref "${ref}" is stale or unknown in this page. Take a new browser_snapshot and use a current ref.`);
}

function pruneRefs(): void {
  for (const [ref, weak] of refToElement) {
    const el = weak.deref();
    if (!el || !el.isConnected) refToElement.delete(ref);
  }
  const curHref = location.href;
  for (const [ref, meta] of refMeta) {
    if (meta.href !== curHref) refMeta.delete(ref);
  }
}

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  try {
    const viaChrome = g.chrome?.dom?.openOrClosedShadowRoot?.(el);
    if (viaChrome) return viaChrome as ShadowRoot;
  } catch {
    // ignore
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viaGecko = (el as any).openOrClosedShadowRoot;
  return viaGecko ? (viaGecko as ShadowRoot) : null;
}

function childNodesOf(node: Element | ShadowRoot): Node[] {
  if ((node as Node).nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    const sr = shadowRootOf(el);
    if (sr) {
      if (!sr.querySelector('slot') && el.childNodes.length > 0) {
        return [...Array.from(sr.childNodes), ...Array.from(el.childNodes)];
      }
      return Array.from(sr.childNodes);
    }
    if (el.localName === 'slot') {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
  }
  return Array.from(node.childNodes);
}

function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active) {
    const sr = shadowRootOf(active);
    if (!sr || !sr.activeElement || sr.activeElement === active) break;
    active = sr.activeElement;
  }
  return active;
}

function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/[\s\u200b\u00ad]+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function shortUrl(href: string): string {
  if (href.startsWith('javascript:')) return 'javascript:';
  try {
    const url = new URL(href, location.href);
    if (
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash
    ) {
      return truncate(url.hash, 36);
    }
    if (url.origin === location.origin) return truncate(url.pathname + url.search + url.hash, 100);
    return truncate(url.href, 120);
  } catch {
    return truncate(href, 120);
  }
}

function attr(el: Element, name: string): string | null {
  return el.getAttribute(name);
}

function textFromElement(el: Element): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = (el as any).innerText as string | undefined;
  let text = collapse(typeof inner === 'string' ? inner : el.textContent);
  if (!text) {
    const labelled = el.querySelector('img[alt]:not([alt=""]), [aria-label], svg title');
    if (labelled) {
      text = collapse(labelled.getAttribute('alt') ?? labelled.getAttribute('aria-label') ?? labelled.textContent);
    }
  }
  return text;
}

function isTextInput(el: Element): el is HTMLInputElement {
  return el.localName === 'input' && TEXT_INPUT_TYPES.has(((el as HTMLInputElement).type || '').toLowerCase());
}

function isContentEditable(el: Element): boolean {
  return (el as HTMLElement).isContentEditable === true;
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el.localName === 'textarea') return !(el as HTMLTextAreaElement).readOnly && !(el as HTMLTextAreaElement).disabled;
  if (isTextInput(el)) return !el.readOnly && !el.disabled;
  return isContentEditable(el);
}

function isDisabled(el: Element): boolean {
  try {
    if (el.matches(':disabled')) return true;
  } catch {
    // ignore unsupported selector contexts
  }
  return attr(el, 'aria-disabled') === 'true';
}

function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  const text = truncate(textFromElement(el), 40);
  return `<${el.localName}${id}${cls}>${text ? ` "${text}"` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Roles, names and states
// ---------------------------------------------------------------------------------------------

function insideSectioning(el: Element): boolean {
  return Boolean(el.parentElement?.closest('article, aside, main, nav, section'));
}

function isLayoutTable(table: Element): boolean {
  const explicit = attr(table, 'role')?.trim().toLowerCase();
  if (explicit === 'table' || explicit === 'grid' || explicit === 'treegrid') return false;
  if (explicit === 'presentation' || explicit === 'none') return true;
  if (attr(table, 'border') !== '0' && !table.parentElement?.closest('table')) return false;
  return !table.querySelector(
    ':scope > caption, :scope > thead th, :scope > tbody > tr > th, :scope > tr > th, [role="columnheader"], [role="rowheader"]',
  );
}

function implicitRole(el: Element): string | null {
  const tag = el.localName;
  switch (tag) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : null;
    case 'button':
      return 'button';
    case 'input': {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      switch (type) {
        case 'button': case 'submit': case 'reset': case 'image': case 'file': return 'button';
        case 'checkbox': return 'checkbox';
        case 'radio': return 'radio';
        case 'range': return 'slider';
        case 'number': return 'spinbutton';
        case 'search': return el.hasAttribute('list') ? 'combobox' : 'searchbox';
        case 'hidden': return null;
        default: return el.hasAttribute('list') ? 'combobox' : 'textbox';
      }
    }
    case 'select': {
      const select = el as HTMLSelectElement;
      return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
    }
    case 'option': return 'option';
    case 'textarea': return 'textbox';
    case 'img': return attr(el, 'alt') === '' ? 'presentation' : 'img';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'ul': case 'ol': case 'menu': return 'list';
    case 'li': return 'listitem';
    case 'dt': return 'term';
    case 'dd': return 'definition';
    case 'table':
      return isLayoutTable(el) ? null : 'table';
    case 'thead': case 'tbody': case 'tfoot': {
      const tbl = el.closest('table');
      return tbl && isLayoutTable(tbl) ? null : 'rowgroup';
    }
    case 'tr': {
      const tbl = el.closest('table');
      if (tbl && isLayoutTable(tbl)) {
        return el.children.length > 1 && Boolean(el.querySelector('a[href]')) && !el.querySelector('table')
          ? 'listitem'
          : null;
      }
      return 'row';
    }
    case 'td': {
      const tbl = el.closest('table');
      return tbl && isLayoutTable(tbl) ? null : 'cell';
    }
    case 'th': return attr(el, 'scope') === 'row' ? 'rowheader' : 'columnheader';
    case 'caption': return 'caption';
    case 'nav': return 'navigation';
    case 'main': return 'main';
    case 'header': return insideSectioning(el) ? null : 'banner';
    case 'footer': return insideSectioning(el) ? null : 'contentinfo';
    case 'aside': return 'complementary';
    case 'form': return 'form';
    case 'search': return 'search';
    case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    case 'article': return 'article';
    case 'dialog': return 'dialog';
    case 'details': return 'group';
    case 'summary': return 'button';
    case 'fieldset': return 'group';
    case 'legend': return 'legend';
    case 'p': return 'paragraph';
    case 'blockquote': return 'blockquote';
    case 'pre': return 'code';
    case 'hr': return 'separator';
    case 'progress': return 'progressbar';
    case 'meter': return 'meter';
    case 'output': return 'status';
    case 'iframe': case 'frame': return 'iframe';
    case 'figure': return 'figure';
    case 'canvas': return 'canvas';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'foreignObject':
    case 'foreignobject':
      return textFromElement(el) ? 'shape' : null;
    case 'text': return el.namespaceURI?.includes('svg') && textFromElement(el) ? 'shape' : null;
    default:
      return isContentEditable(el) && !isContentEditable(el.parentElement ?? el) ? 'textbox' : null;
  }
}

function computeRole(el: Element): string | null {
  const explicit = attr(el, 'role')?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit) return explicit;
  return implicitRole(el);
}

function labelText(el: Element): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const labels = (el as any).labels as NodeListOf<HTMLLabelElement> | null | undefined;
  if (!labels || labels.length === 0) return '';
  const parts: string[] = [];
  for (const label of Array.from(labels)) {
    const clone = label.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
    parts.push(collapse(clone.textContent));
  }
  return collapse(parts.join(' '));
}

function accessibleName(el: Element, role: string, maxChars = 150): string {
  const labelledBy = attr(el, 'aria-labelledby');
  if (labelledBy) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const text = labelledBy
      .split(/\s+/)
      .map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id)))
      .filter((n): n is HTMLElement => Boolean(n))
      .map((n) => textFromElement(n))
      .join(' ');
    if (collapse(text)) return truncate(collapse(text), maxChars);
  }
  const ariaLabel = collapse(attr(el, 'aria-label'));
  if (ariaLabel) return truncate(ariaLabel, maxChars);

  if (el.id === 't-name-box') return 'Name box';
  if (el.id === 't-formula-bar-input' || (el.classList?.contains('cell-input') && el.closest('#t-formula-bar-input'))) {
    return 'Formula bar';
  }
  if (el.classList?.contains('docs-title-input')) return 'Document title';

  const tag = el.localName;
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'meter' || tag === 'progress' || tag === 'output') {
    const type = tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : '';
    if (type === 'button' || type === 'submit' || type === 'reset') {
      const value = (el as HTMLInputElement).value;
      return truncate(collapse(value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''), maxChars);
    }
    if (type === 'image') return truncate(collapse(attr(el, 'alt') ?? attr(el, 'value') ?? 'Submit'), maxChars);
    const fromLabel = labelText(el);
    if (fromLabel) return truncate(fromLabel, maxChars);
    if (type === 'file') return 'Choose file';
    const placeholder = collapse(attr(el, 'placeholder'));
    if (placeholder) return truncate(placeholder, maxChars);
  }
  if (tag === 'img' || tag === 'area') {
    const alt = collapse(attr(el, 'alt'));
    if (alt) return truncate(alt, maxChars);
  }
  if (tag === 'fieldset') {
    const legend = el.querySelector(':scope > legend');
    if (legend) return truncate(textFromElement(legend), maxChars);
  }
  if (tag === 'table') {
    const caption = el.querySelector(':scope > caption');
    if (caption) return truncate(textFromElement(caption), maxChars);
  }
  if (tag === 'figure') {
    const caption = el.querySelector(':scope > figcaption');
    if (caption) return truncate(textFromElement(caption), maxChars);
  }
  if (NAME_FROM_CONTENT.has(role) || tag === 'summary') {
    const text = textFromElement(el);
    if (text) return truncate(text, maxChars);
  }
  const title = collapse(attr(el, 'title'));
  return title ? truncate(title, maxChars) : '';
}

function controlValue(el: Element): string | undefined {
  const tag = el.localName;
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.type || 'text').toLowerCase();
    if (type === 'password') return input.value ? '••••••' : '';
    if (type === 'file') return input.files && input.files.length ? Array.from(input.files).map((f) => f.name).join(', ') : '';
    if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden'].includes(type)) return undefined;
    return truncate(input.value, 200);
  }
  if (tag === 'textarea') return truncate((el as HTMLTextAreaElement).value, 300);
  if (tag === 'select') {
    const selected = Array.from((el as HTMLSelectElement).selectedOptions).map((o) => collapse(o.label || o.text));
    return truncate(selected.join(', '), 200);
  }
  if (isContentEditable(el)) return truncate(textFromElement(el), 300);
  const ariaValue = attr(el, 'aria-valuetext') ?? attr(el, 'aria-valuenow');
  if (ariaValue !== null) return truncate(ariaValue, 100);
  if (tag === 'progress' || tag === 'meter') return String((el as HTMLProgressElement).value);
  return undefined;
}

function addStates(el: Element, role: string, attrs: string[], active: Element | null): void {
  if (role === 'heading') {
    const level = attr(el, 'aria-level') ?? /^h([1-6])$/.exec(el.localName)?.[1];
    if (level) attrs.push(`level=${level}`);
  }
  if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
    let checked: string | boolean | null;
    if (el.localName === 'input') {
      const input = el as HTMLInputElement;
      checked = input.indeterminate ? 'mixed' : input.checked;
    } else {
      checked = attr(el, 'aria-checked');
    }
    if (checked === true || checked === 'true') attrs.push('checked');
    else if (checked === 'mixed') attrs.push('checked=mixed');
  }
  const pressed = attr(el, 'aria-pressed');
  if (pressed === 'true') attrs.push('pressed');
  else if (pressed === 'mixed') attrs.push('pressed=mixed');
  const expanded = attr(el, 'aria-expanded');
  if (expanded === 'true') attrs.push('expanded');
  else if (expanded === 'false') attrs.push('expanded=false');
  if (el.localName === 'details') attrs.push((el as HTMLDetailsElement).open ? 'expanded' : 'expanded=false');
  if (el.localName === 'summary' && el.parentElement?.localName === 'details') {
    attrs.push((el.parentElement as HTMLDetailsElement).open ? 'expanded' : 'expanded=false');
  }
  if (attr(el, 'aria-selected') === 'true' || (el.localName === 'option' && (el as HTMLOptionElement).selected)) attrs.push('selected');
  if (isDisabled(el)) attrs.push('disabled');
  if (el.hasAttribute('required') || attr(el, 'aria-required') === 'true') attrs.push('required');
  if ((el.hasAttribute('readonly') && (el.localName === 'input' || el.localName === 'textarea')) || attr(el, 'aria-readonly') === 'true') attrs.push('readonly');
  const invalid = attr(el, 'aria-invalid');
  if (invalid && invalid !== 'false') attrs.push('invalid');
  const current = attr(el, 'aria-current');
  if (current && current !== 'false') attrs.push('current');
  if (el === active) attrs.push('focused');
  if (role === 'link') {
    const href = (el as HTMLAnchorElement).href;
    if (typeof href === 'string' && href) attrs.push(`href=${shortUrl(href)}`);
  }
  if (el.localName === 'input' && (el as HTMLInputElement).type === 'password') attrs.push('password');
  if (el.localName === 'textarea' || attr(el, 'aria-multiline') === 'true') attrs.push('multiline');
  if (role === 'slider' || role === 'spinbutton' || role === 'progressbar' || role === 'meter') {
    const min = attr(el, 'aria-valuemin') ?? attr(el, 'min');
    const max = attr(el, 'aria-valuemax') ?? attr(el, 'max');
    if (min !== null) attrs.push(`min=${min}`);
    if (max !== null) attrs.push(`max=${max}`);
  }
  if (role === 'canvas' || role === 'video') {
    const rect = el.getBoundingClientRect();
    attrs.push(`size=${Math.round(rect.width)}x${Math.round(rect.height)}`);
  }
  if (role === 'iframe') {
    const src = attr(el, 'src');
    if (src) attrs.push(`src=${shortUrl(src)}`);
  }
  if (el.localName === 'select') attrs.push(`options=${(el as HTMLSelectElement).options.length}`);
}

function needsRef(el: Element, role: string, pointer: boolean): boolean {
  if (INTERACTIVE.has(role)) return true;
  if (pointer) return true;
  if (role === 'generic') return true;
  const tabindex = attr(el, 'tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  return isContentEditable(el);
}

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

function intersectsViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  const margin = 50;
  return rect.bottom >= -margin && rect.right >= -margin && rect.top <= innerHeight + margin && rect.left <= innerWidth + margin;
}

function pushText(out: Array<SNode | string>, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (typeof last === 'string') out[out.length - 1] = `${last} ${text}`;
  else out.push(text);
}

function visitChildren(parent: Element | ShadowRoot, ctx: WalkContext, out: Array<SNode | string>): void {
  for (const child of childNodesOf(parent)) visitNode(child, ctx, out);
}

function visitNode(node: Node, ctx: WalkContext, out: Array<SNode | string>): void {
  if (node.nodeType === Node.TEXT_NODE) {
    if (!ctx.hidden) pushText(out, collapse(node.nodeValue));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.localName;
  if (SKIP_TAGS.has(tag) || SKIP_TAGS.has(tag.toLowerCase())) return;
  if (attr(el, 'aria-hidden') === 'true') return;
  if (tag === 'input' && ((el as HTMLInputElement).type || '').toLowerCase() === 'hidden') return;

  const style = getComputedStyle(el);
  if (style.display === 'none') return;
  if (style.display === 'contents') {
    visitChildren(el, ctx, out);
    return;
  }
  if (style.visibility === 'hidden' || style.visibility === 'collapse') {
    visitChildren(el, { ...ctx, hidden: true }, out);
    return;
  }
  const childCtx: WalkContext = { ...ctx, hidden: false, parentCursor: style.cursor };
  if (ctx.viewportOnly && !intersectsViewport(el)) return;
  if (style.overflow === 'hidden' || style.overflow === 'clip') {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
  }

  if (tag === 'svg') {
    const hasDiagramContent = !ctx.insideInteractive && Boolean(el.querySelector('foreignObject, text, [role], a[href]'));
    const rect = hasDiagramContent ? el.getBoundingClientRect() : null;
    const isCanvasSvg = Boolean(hasDiagramContent && rect && (rect.width >= 64 || rect.height >= 64));
    if (isCanvasSvg) {
      visitChildren(el, childCtx, out);
      return;
    }
    const label = collapse(attr(el, 'aria-label')) || collapse(el.querySelector('title')?.textContent);
    const role = attr(el, 'role');
    if (label && role !== 'presentation' && role !== 'none') out.push({ role: 'img', name: truncate(label, 150), attrs: [], children: [] });
    return;
  }

  let role = computeRole(el);
  const pointer = style.cursor === 'pointer' && ctx.parentCursor !== 'pointer' && !ctx.insideInteractive;
  const tabindex = attr(el, 'tabindex');
  const focusable = tabindex !== null && Number(tabindex) >= 0;
  if (role === 'presentation' || role === 'none') role = null;
  if (!role && (pointer || (focusable && !ctx.insideInteractive) || el.hasAttribute('onclick'))) role = 'generic';
  if (!role) {
    visitChildren(el, childCtx, out);
    return;
  }

  const n: SNode = { role, name: '', attrs: [], children: [] };
  const genericPointer = role === 'generic' && pointer;
  n.name = role === 'generic' ? (genericPointer ? accessibleName(el, 'button', 80) : accessibleName(el, role, 80)) : accessibleName(el, role);
  addStates(el, role, n.attrs, ctx.active);
  if (genericPointer) n.attrs.push('cursor=pointer');
  if (needsRef(el, role, pointer)) n.ref = refFor(el);
  const value = role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton' || role === 'slider' || role === 'listbox' || role === 'progressbar' || role === 'meter'
    ? controlValue(el)
    : undefined;
  if (value !== undefined && value !== '') n.value = value;

  if (tag === 'select') {
    const options = Array.from((el as HTMLSelectElement).options);
    if (options.length <= 25) {
      n.children = options.map((o) => ({
        role: 'option',
        name: truncate(collapse(o.label || o.text), 100),
        attrs: o.selected ? ['selected'] : [],
        children: [],
      }));
    }
  } else if (!LEAF_ROLES.has(role) && !(tag === 'input')) {
    const childOut: Array<SNode | string> = [];
    visitChildren(el, { ...childCtx, insideInteractive: ctx.insideInteractive || INTERACTIVE.has(role) || pointer }, childOut);
    const nameFromContent = (NAME_FROM_CONTENT.has(role) || genericPointer) && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby');
    n.children = nameFromContent ? childOut.filter((c): c is SNode => typeof c !== 'string' && containsRef(c)) : childOut;
  }

  if (!n.name && !n.ref && n.value === undefined && n.children.length === 0 && PRUNABLE.has(role)) return;
  out.push(n);
}

function containsRef(node: SNode): boolean {
  if (node.ref) return true;
  return node.children.some((c) => typeof c !== 'string' && containsRef(c));
}

class Writer {
  lines: string[] = [];
  length = 0;
  full = false;
  omitted = 0;

  constructor(private readonly maxChars: number) {}

  push(line: string): void {
    if (this.full) {
      this.omitted++;
      return;
    }
    if (this.length + line.length + 1 > this.maxChars) {
      this.full = true;
      this.omitted++;
      return;
    }
    this.lines.push(line);
    this.length += line.length + 1;
  }
}

function render(node: SNode | string, depth: number, w: Writer): void {
  const indent = '  '.repeat(depth);
  if (typeof node === 'string') {
    w.push(`${indent}- text: ${truncate(node, 400)}`);
    return;
  }
  let line = `${indent}- ${node.role}`;
  if (node.name) line += ` ${quote(node.name)}`;
  for (const a of node.attrs) line += ` [${a}]`;
  if (node.ref) line += ` [ref=${node.ref}]`;
  const elementChildren = node.children.filter((c) => typeof c !== 'string');
  const textLimit = node.role === 'code' ? 1200 : 400;
  if (node.value !== undefined) {
    line += `: ${quote(node.value)}`;
  } else if (elementChildren.length === 0 && node.children.length > 0) {
    const text = node.children.join(' ');
    if (text && text !== node.name) line += `: ${truncate(text, textLimit)}`;
    w.push(line);
    return;
  }
  w.push(line);
  if (elementChildren.length > 0 || node.value !== undefined) {
    for (const child of node.children) render(child, depth + 1, w);
  }
}

const BOILERPLATE_LANDMARKS = new Set(['banner', 'navigation', 'complementary', 'contentinfo']);
const ALWAYS_KEEP_ROLES = new Set(['search', 'searchbox', 'combobox', 'textbox', 'form', 'dialog']);

function hasMainLandmark(nodes: Array<SNode | string>): boolean {
  for (const item of nodes) {
    if (typeof item === 'string') continue;
    if (item.role === 'main') return true;
    if (hasMainLandmark(item.children)) return true;
  }
  return false;
}

function containsKeepRole(node: SNode): boolean {
  if (ALWAYS_KEEP_ROLES.has(node.role)) return true;
  return node.children.some((c) => typeof c !== 'string' && containsKeepRole(c));
}

function compactBoilerplateTree(nodes: Array<SNode | string>, insideBoilerplate = false): Array<SNode | string> {
  const out: Array<SNode | string> = [];
  let navLinksSeen = 0;
  let navLinksOmitted = 0;

  for (const item of nodes) {
    if (typeof item === 'string') {
      if (!insideBoilerplate || out.length < 8) out.push(item);
      continue;
    }
    if (item.role === 'main' || item.role === 'dialog' || item.role === 'form') {
      out.push(item);
      continue;
    }
    const enteringBoilerplate = insideBoilerplate || BOILERPLATE_LANDMARKS.has(item.role);
    if (enteringBoilerplate && !containsKeepRole(item)) {
      const isNavLeaf = item.role === 'link' || item.role === 'menuitem';
      const isPureLinkItem =
        item.role === 'listitem' &&
        item.children.length > 0 &&
        item.children.every((c) => typeof c === 'string' || c.role === 'link' || c.role === 'list');
      if (isNavLeaf || isPureLinkItem) {
        navLinksSeen++;
        if (navLinksSeen > 6) {
          navLinksOmitted++;
          continue;
        }
      }
    }
    out.push({
      ...item,
      children: compactBoilerplateTree(item.children, enteringBoilerplate),
    });
  }
  if (navLinksOmitted > 0) {
    out.push(`[… ${navLinksOmitted} navigation links collapsed to preserve main content]`);
  }
  return out;
}

function countIframeNodes(nodes: Array<SNode | string>): number {
  let count = 0;
  for (const item of nodes) {
    if (typeof item === 'string') continue;
    if (item.role === 'iframe') count++;
    if (item.children.length > 0) count += countIframeNodes(item.children);
  }
  return count;
}

function extractBalancedJson(source: string, startIdx: number): string | null {
  let i = startIdx;
  while (i < source.length && /\s/.test(source[i])) i++;
  const open = source[i];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let pos = i; pos < source.length; pos++) {
    const ch = source[pos];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return source.slice(i, pos + 1);
    }
  }
  return null;
}

function extractGoogleDocsCanvasText(): string {
  if (location.hostname !== 'docs.google.com' || !location.pathname.startsWith('/document/')) return '';
  if (!document.querySelector('canvas.kix-canvas-tile-content, .kix-appview-editor')) return '';
  const chunks: string[] = [];
  const marker = 'DOCS_modelChunk';
  for (const script of Array.from(document.scripts)) {
    const raw = script.textContent ?? '';
    if (!raw.includes(marker)) continue;
    let searchFrom = 0;
    for (;;) {
      const idx = raw.indexOf(marker, searchFrom);
      if (idx < 0) break;
      const eqIdx = raw.indexOf('=', idx + marker.length);
      if (eqIdx < 0 || eqIdx - idx > 32) {
        searchFrom = idx + marker.length;
        continue;
      }
      const jsonSlice = extractBalancedJson(raw, eqIdx + 1);
      searchFrom = eqIdx + 1;
      if (!jsonSlice) continue;
      try {
        const parsed = JSON.parse(jsonSlice) as { chunk?: Array<{ ty?: string; s?: string }> } | Array<{ ty?: string; s?: string }>;
        const arr = Array.isArray(parsed) ? parsed : parsed?.chunk;
        if (!Array.isArray(arr)) continue;
        for (const entry of arr) {
          if (entry?.ty === 'is' && typeof entry.s === 'string' && entry.s) {
            chunks.push(entry.s.replace(/\u000b/g, '\n').replace(/\r/g, ''));
          }
        }
      } catch {
        // ignore non-JSON assignment
      }
    }
  }
  return chunks.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function snapshot(options: SnapshotOptions = {}): SnapshotResult {
  pruneRefs();
  const maxChars = Math.max(1000, Math.min(options.maxChars ?? 20000, 200000));
  const rootEl = options.root ? resolve(options.root) : document.body ?? document.documentElement;
  const ctx: WalkContext = {
    viewportOnly: Boolean(options.viewportOnly),
    parentCursor: 'auto',
    insideInteractive: false,
    hidden: false,
    active: deepActiveElement(),
  };
  const out: Array<SNode | string> = [];
  if (rootEl) {
    if (options.root) visitNode(rootEl, ctx, out);
    else visitChildren(rootEl, ctx, out);
  }
  if (!options.root) {
    const gdocsCanvasText = extractGoogleDocsCanvasText();
    if (gdocsCanvasText) {
      const paragraphs = gdocsCanvasText
        .split('\n')
        .map((line) => collapse(line))
        .filter(Boolean)
        .slice(0, 120);
      if (paragraphs.length > 0) {
        out.push({
          role: 'document',
          name: 'Google Docs Canvas Text',
          attrs: [],
          children: paragraphs.map((p) => ({ role: 'paragraph', name: '', attrs: [], children: [p] })),
        });
      }
    }
  }
  const visibleIframes = countIframeNodes(out);
  let w = new Writer(maxChars);
  for (const node of out) render(node, 0, w);
  if (w.full && !options.root && hasMainLandmark(out)) {
    const compacted = compactBoilerplateTree(out);
    const w2 = new Writer(maxChars);
    for (const node of compacted) render(node, 0, w2);
    w = w2;
  }
  return {
    text: w.lines.join('\n'),
    truncated: w.full,
    omittedNodes: w.omitted,
    visibleIframes,
    url: location.href,
    title: document.title,
    isTop: window === window.top,
    width: innerWidth,
    height: innerHeight,
  };
}

const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root)$/;

/**
 * Visible text in composed-tree order (shadow roots and slots included), unlike innerText which
 * stops at shadow boundaries in Chromium. Block-level boxes become line breaks.
 */
function composedText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Element | ShadowRoot, hidden: boolean) => {
    for (const child of childNodesOf(node)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!hidden && child.nodeValue) parts.push(child.nodeValue.replace(/\s+/g, ' '));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      if (SKIP_TAGS.has(el.localName)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;
      const block = BLOCK_DISPLAY.test(style.display) || el.localName === 'br';
      if (block) parts.push('\n');
      walk(el, style.visibility === 'hidden' || style.visibility === 'collapse');
      if (block) parts.push('\n');
    }
  };
  walk(root, false);
  return parts.join('').split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter((line, i, all) => line || (i > 0 && all[i - 1])).join('\n').trim();
}

function hasShadowRoots(): boolean {
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (shadowRootOf(node as Element)) return true;
  }
  return false;
}

function pageText(): string {
  const gdocsCanvasText = extractGoogleDocsCanvasText();
  const body = document.body ?? document.documentElement;
  if (!body) return gdocsCanvasText;
  const domText = hasShadowRoots() ? composedText(body) : ((body as HTMLElement).innerText ?? body.textContent ?? '');
  return gdocsCanvasText ? `${gdocsCanvasText}\n\n${domText}` : domText;
}

function getText(maxChars = 20000): { text: string; truncated: boolean; url: string; title: string; isTop: boolean } {
  const raw = pageText().replace(/\n{3,}/g, '\n\n').trim();
  const limit = Math.max(500, Math.min(maxChars, 500000));
  return { text: raw.slice(0, limit), truncated: raw.length > limit, url: location.href, title: document.title, isTop: window === window.top };
}

// ---------------------------------------------------------------------------------------------
// Pointer helpers
// ---------------------------------------------------------------------------------------------

function isShadowIncludingDescendant(ancestor: Element, node: Node | null): boolean {
  let current: Node | null = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentNode ?? (current as ShadowRoot).host ?? null;
  }
  return false;
}

function deepElementFromPoint(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  while (hit) {
    const sr = shadowRootOf(hit);
    if (!sr) break;
    const inner = sr.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

function scrollIntoViewIfNeeded(el: Element): void {
  const rect = el.getBoundingClientRect();
  const visible = rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
  if (!visible) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
}

function isOwnHit(el: Element, hit: Element): boolean {
  return isShadowIncludingDescendant(el, hit) || (hit.localName === 'label' && (hit as HTMLLabelElement).control === el);
}

function pointFor(el: Element): PointResult {
  scrollIntoViewIfNeeded(el);
  const rects = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  const rect = rects.find((r) => r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0) ?? rects[0] ?? el.getBoundingClientRect();
  const left = Math.max(rect.left, 0);
  const right = Math.min(rect.right, innerWidth);
  const top = Math.max(rect.top, 0);
  const bottom = Math.min(rect.bottom, innerHeight);
  const spanX = right > left ? right - left : rect.width;
  const spanY = bottom > top ? bottom - top : rect.height;
  const baseX = right > left ? left : rect.left;
  const baseY = bottom > top ? top : rect.top;

  const probes: Array<[number, number]> = [
    [0.5, 0.5],
    [0.25, 0.5],
    [0.75, 0.5],
    [0.5, 0.25],
    [0.5, 0.75],
    [0.2, 0.2],
  ];

  let firstHit: Element | null = null;
  const centerX = baseX + spanX * 0.5;
  const centerY = baseY + spanY * 0.5;
  for (let i = 0; i < probes.length; i++) {
    const [fx, fy] = probes[i];
    const px = baseX + spanX * fx;
    const py = baseY + spanY * fy;
    const hit = deepElementFromPoint(px, py);
    if (i === 0) firstHit = hit;
    if (hit && isOwnHit(el, hit)) {
      return { x: px, y: py, covered: null };
    }
  }

  const covered = !firstHit
    ? 'nothing is rendered at the element center (it may be off-screen or zero-sized)'
    : `covered by ${describe(firstHit)}`;
  return { x: centerX, y: centerY, covered };
}

interface BoxResult {
  x: number;
  y: number;
  viewportX: number;
  viewportY: number;
  width: number;
  height: number;
  dpr: number;
}

function boxFor(ref: string, scroll = false): BoxResult {
  const el = resolve(ref);
  if (scroll) scrollIntoViewIfNeeded(el);
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error('Element has zero width or height and cannot be captured.');
  }
  return {
    x: rect.left + scrollX,
    y: rect.top + scrollY,
    viewportX: rect.left,
    viewportY: rect.top,
    width: rect.width,
    height: rect.height,
    dpr: devicePixelRatio || 1,
  };
}

function pageMetrics(): { width: number; height: number; viewportWidth: number; viewportHeight: number; scrollX: number; scrollY: number; dpr: number } {
  const doc = document.documentElement;
  const body = document.body;
  const width = Math.max(doc?.scrollWidth ?? 0, doc?.clientWidth ?? 0, body?.scrollWidth ?? 0, innerWidth);
  const height = Math.max(doc?.scrollHeight ?? 0, doc?.clientHeight ?? 0, body?.scrollHeight ?? 0, innerHeight);
  return { width, height, viewportWidth: innerWidth, viewportHeight: innerHeight, scrollX, scrollY, dpr: devicePixelRatio || 1 };
}

function frameOffset(frameUrl: string): { x: number; y: number; viewportX: number; viewportY: number } | null {
  const frames = Array.from(document.querySelectorAll('iframe, frame')).filter((el) => {
    const src = (el as HTMLIFrameElement).src;
    return src && src === frameUrl;
  });
  if (frames.length !== 1) return null;
  const rect = frames[0].getBoundingClientRect();
  const style = getComputedStyle(frames[0]);
  const borderLeft = parseFloat(style.borderLeftWidth || '0') || 0;
  const borderTop = parseFloat(style.borderTopWidth || '0') || 0;
  const padLeft = parseFloat(style.paddingLeft || '0') || 0;
  const padTop = parseFloat(style.paddingTop || '0') || 0;
  const vx = rect.left + borderLeft + padLeft;
  const vy = rect.top + borderTop + padTop;
  return { x: vx + scrollX, y: vy + scrollY, viewportX: vx, viewportY: vy };
}

function mouseInit(x: number, y: number, extra: MouseEventInit = {}): MouseEventInit {
  return { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x + screenX, screenY: y + screenY, ...extra };
}

function dispatchPointer(el: Element, type: string, x: number, y: number, extra: MouseEventInit = {}): boolean {
  const init = mouseInit(x, y, extra);
  if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
    return el.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  }
  return el.dispatchEvent(new MouseEvent(type, init));
}

function focusTarget(el: Element): void {
  const focusable = el.closest('a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]') as HTMLElement | null;
  const target = focusable ?? (el as HTMLElement);
  if (typeof target.focus === 'function') target.focus({ preventScroll: true });
}

interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  modifiers?: string[];
}

function modifierFlags(modifiers: string[] = []): Pick<MouseEventInit, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'> {
  const set = new Set(modifiers.map((m) => m.toLowerCase()));
  return {
    ctrlKey: set.has('control') || set.has('ctrl'),
    shiftKey: set.has('shift'),
    altKey: set.has('alt'),
    metaKey: set.has('meta') || set.has('cmd'),
  };
}

function domClick(ref: string, options: ClickOptions = {}): { covered: string | null } {
  const el = resolve(ref);
  const { x, y, covered } = pointFor(el);
  const button = options.button === 'right' ? 2 : options.button === 'middle' ? 1 : 0;
  const buttonsMask = button === 2 ? 2 : button === 1 ? 4 : 1;
  const flags = modifierFlags(options.modifiers);
  dispatchPointer(el, 'pointerover', x, y, flags);
  dispatchPointer(el, 'mouseover', x, y, flags);
  dispatchPointer(el, 'pointermove', x, y, flags);
  dispatchPointer(el, 'mousemove', x, y, flags);
  const clicks = Math.max(1, Math.min(options.clickCount ?? 1, 3));
  for (let i = 1; i <= clicks; i++) {
    dispatchPointer(el, 'pointerdown', x, y, { ...flags, button, buttons: buttonsMask, detail: i });
    const proceed = dispatchPointer(el, 'mousedown', x, y, { ...flags, button, buttons: buttonsMask, detail: i });
    if (proceed && i === 1) focusTarget(el);
    dispatchPointer(el, 'pointerup', x, y, { ...flags, button, buttons: 0, detail: i });
    dispatchPointer(el, 'mouseup', x, y, { ...flags, button, buttons: 0, detail: i });
    if (button === 0) dispatchPointer(el, 'click', x, y, { ...flags, button, buttons: 0, detail: i });
    else if (button === 1) dispatchPointer(el, 'auxclick', x, y, { ...flags, button, buttons: 0, detail: i });
  }
  if (button === 0 && clicks >= 2) dispatchPointer(el, 'dblclick', x, y, { ...flags, button, buttons: 0, detail: 2 });
  if (button === 2) dispatchPointer(el, 'contextmenu', x, y, { ...flags, button, buttons: 0 });
  return { covered };
}

function domHover(ref: string): { covered: string | null } {
  const el = resolve(ref);
  const { x, y, covered } = pointFor(el);
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
    const init = type.endsWith('enter') ? { bubbles: false } : {};
    dispatchPointer(el, type, x, y, init);
  }
  return { covered };
}

function domDrag(fromX: number, fromY: number, toX: number, toY: number, steps = 10): { fromX: number; fromY: number; toX: number; toY: number } {
  const startEl = deepElementFromPoint(fromX, fromY) ?? document.body ?? document.documentElement;
  const count = Math.max(2, Math.min(steps, 60));
  dispatchPointer(startEl, 'pointerover', fromX, fromY);
  dispatchPointer(startEl, 'mouseover', fromX, fromY);
  dispatchPointer(startEl, 'pointermove', fromX, fromY);
  dispatchPointer(startEl, 'mousemove', fromX, fromY);
  dispatchPointer(startEl, 'pointerdown', fromX, fromY, { button: 0, buttons: 1, detail: 1 });
  dispatchPointer(startEl, 'mousedown', fromX, fromY, { button: 0, buttons: 1, detail: 1 });
  for (let i = 1; i <= count; i++) {
    const x = fromX + ((toX - fromX) * i) / count;
    const y = fromY + ((toY - fromY) * i) / count;
    const curEl = deepElementFromPoint(x, y) ?? startEl;
    dispatchPointer(curEl, 'pointermove', x, y, { button: 0, buttons: 1 });
    dispatchPointer(curEl, 'mousemove', x, y, { button: 0, buttons: 1 });
  }
  const endEl = deepElementFromPoint(toX, toY) ?? startEl;
  dispatchPointer(endEl, 'pointerup', toX, toY, { button: 0, buttons: 0, detail: 1 });
  dispatchPointer(endEl, 'mouseup', toX, toY, { button: 0, buttons: 0, detail: 1 });
  return { fromX: Math.round(fromX), fromY: Math.round(fromY), toX: Math.round(toX), toY: Math.round(toY) };
}

// ---------------------------------------------------------------------------------------------
// Text entry
// ---------------------------------------------------------------------------------------------

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fireInput(el: Element, data: string | null, inputType = 'insertText'): void {
  const init = { bubbles: true, cancelable: false, composed: true, data, inputType };
  el.dispatchEvent(typeof InputEvent === 'function' ? new InputEvent('input', init) : new Event('input', init));
}

function fireChange(el: Element): void {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectAllIn(el: Element): void {
  if (el.localName === 'input' || el.localName === 'textarea') {
    const control = el as HTMLInputElement;
    try {
      control.select();
    } catch {
      // number/email inputs may not support selection APIs
    }
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function caretToEnd(el: Element): void {
  if (el.localName === 'input' || el.localName === 'textarea') {
    const control = el as HTMLInputElement;
    try {
      const len = control.value.length;
      control.setSelectionRange(len, len);
    } catch {
      // ignore unsupported input types
    }
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function isValueInput(el: Element): el is HTMLInputElement {
  return el.localName === 'input' && VALUE_INPUT_TYPES.has(((el as HTMLInputElement).type || '').toLowerCase()) && !isDisabled(el);
}

function editableTarget(ref: string): Element {
  const el = resolve(ref);
  if (isEditable(el) || isValueInput(el)) return el;
  const inner = el.querySelector('input, textarea, [contenteditable=""], [contenteditable="true"]');
  if (inner && isEditable(inner)) return inner;
  const tag = el.localName;
  if (tag === 'input' || tag === 'textarea') throw new Error(`Element ${ref} is disabled or read-only.`);
  throw new Error(`Element ${ref} (${describe(el)}) is not an editable text field.`);
}

/** Inserts text at the caret, preferring the browser editing pipeline for framework compatibility. */
function insertText(el: Element, text: string): void {
  const control = el.localName === 'input' || el.localName === 'textarea' ? (el as HTMLInputElement) : null;
  const before = control ? control.value : el.textContent ?? '';
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch {
    inserted = false;
  }
  const after = control ? control.value : el.textContent ?? '';
  if (inserted && after !== before) return;
  if (text === '') return;
  if (control) {
    const start = control.selectionStart ?? control.value.length;
    const end = control.selectionEnd ?? control.value.length;
    setNativeValue(control, control.value.slice(0, start) + text + control.value.slice(end));
    try {
      control.setSelectionRange(start + text.length, start + text.length);
    } catch {
      // ignore unsupported input types
    }
  } else {
    const selection = getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    } else {
      el.appendChild(document.createTextNode(text));
    }
  }
  fireInput(el, text);
}

/**
 * Focuses the field and prepares the caret. With `clear`, the existing content is selected so the
 * next insertion replaces it; when selection is unsupported (e.g. type=number) it is cleared directly.
 * Returns `kind: "value"` for caret-less inputs (date, color, ...) that must be set with setValue.
 */
function focusForTyping(ref: string, clear: boolean): { kind: string; inForm: boolean } {
  const el = editableTarget(ref);
  const inForm = Boolean(el.closest('form'));
  scrollIntoViewIfNeeded(el);
  (el as HTMLElement).focus({ preventScroll: true });
  if (isValueInput(el)) return { kind: 'value', inForm };
  if (clear) {
    selectAllIn(el);
    if (el.localName === 'input' || el.localName === 'textarea') {
      const control = el as HTMLInputElement;
      let selectedAll = false;
      try {
        selectedAll = control.selectionStart === 0 && control.selectionEnd === control.value.length;
      } catch {
        selectedAll = false;
      }
      if (!selectedAll && control.value) {
        setNativeValue(control, '');
        fireInput(control, null, 'deleteContentBackward');
      }
    }
  } else {
    caretToEnd(el);
  }
  return { kind: el.localName === 'input' || el.localName === 'textarea' ? el.localName : 'contenteditable', inForm };
}

function setValue(ref: string, value: string): { value: string; inForm: boolean } {
  const el = editableTarget(ref) as HTMLInputElement;
  setNativeValue(el, value);
  fireInput(el, value, 'insertReplacementText');
  fireChange(el);
  return { value: el.value, inForm: Boolean(el.closest('form')) };
}

function isChecked(ref: string): { checked: boolean | null } {
  const el = resolve(ref);
  if (el.localName === 'input' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type)) return { checked: (el as HTMLInputElement).checked };
  const aria = attr(el, 'aria-checked') ?? attr(el, 'aria-pressed') ?? attr(el, 'aria-selected');
  return { checked: aria === null ? null : aria === 'true' };
}

function keyboardInit(press: KeyPress, overrides: KeyboardEventInit = {}): KeyboardEventInit {
  const mods = new Set(press.modifiers);
  const init: KeyboardEventInit & { keyCode?: number; which?: number; charCode?: number } = {
    key: press.def.key,
    code: press.def.code,
    location: press.def.location ?? 0,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: mods.has('Control'),
    shiftKey: mods.has('Shift'),
    altKey: mods.has('Alt'),
    metaKey: mods.has('Meta'),
    keyCode: press.def.keyCode,
    which: press.def.keyCode,
    ...overrides,
  };
  return init;
}

function dispatchKey(target: Element, type: 'keydown' | 'keypress' | 'keyup', press: KeyPress, overrides: KeyboardEventInit = {}): boolean {
  return target.dispatchEvent(new KeyboardEvent(type, keyboardInit(press, overrides)));
}

function domType(ref: string, text: string, options: { clear?: boolean; slowly?: boolean; submit?: boolean } = {}): { value: string; inForm: boolean } {
  const { kind, inForm } = focusForTyping(ref, options.clear !== false);
  if (kind === 'value') return setValue(ref, text);
  const el = editableTarget(ref);
  if (!options.slowly && options.clear !== false && (el.localName === 'input' || el.localName === 'textarea') && text.length > 1500) {
    const out = setValue(ref, text);
    if (options.submit) domPress('Enter');
    return out;
  }
  if (options.slowly) {
    if (options.clear !== false) insertText(el, '');
    for (const ch of text) {
      const press = parseKeyCombo(ch === '\n' ? 'Enter' : ch);
      const target = deepActiveElement() ?? el;
      const proceed = dispatchKey(target, 'keydown', press);
      if (proceed && dispatchKey(target, 'keypress', press, { charCode: ch.charCodeAt(0) } as KeyboardEventInit)) {
        insertText(target, ch === '\n' ? '\n' : ch);
      }
      dispatchKey(target, 'keyup', press);
    }
  } else {
    insertText(el, text);
  }
  if (el.localName === 'input' || el.localName === 'textarea') fireChange(el);
  if (options.submit) domPress('Enter');
  return { value: controlValue(el) ?? '', inForm };
}

// ---------------------------------------------------------------------------------------------
// Keyboard emulation (used when trusted input is unavailable, e.g. Firefox)
// ---------------------------------------------------------------------------------------------

function tabbables(): HTMLElement[] {
  const selector = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';
  const all = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => {
    if (isDisabled(el)) return false;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) < 0) return false;
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
  const positive = all.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
  const natural = all.filter((el) => el.tabIndex <= 0);
  return [...positive, ...natural];
}

function moveFocus(backwards: boolean): void {
  const list = tabbables();
  if (list.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const index = active ? list.indexOf(active) : -1;
  const next = backwards ? list[(index - 1 + list.length) % list.length] : list[(index + 1) % list.length];
  next.focus();
}

function scrollContainerAtCenter(): Element | null {
  let el: Element | null = deepElementFromPoint(innerWidth / 2, innerHeight / 2);
  while (el && el !== document.body && el !== document.documentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(style.overflowY + style.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) return el;
    el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
  }
  return null;
}

function defaultKeyAction(press: KeyPress, target: Element): void {
  const key = press.def.key;
  const mods = new Set(press.modifiers);
  const command = mods.has('Control') || mods.has('Meta');
  const editable = isEditable(target);
  if (command && key.toLowerCase() === 'a') {
    if (editable) selectAllIn(target);
    else getSelection()?.selectAllChildren(document.body);
    return;
  }
  if (command || mods.has('Alt')) return;
  switch (key) {
    case 'Enter': {
      if (target.localName === 'textarea' || isContentEditable(target)) {
        insertText(target, '\n');
      } else if (target.localName === 'input' && (target as HTMLInputElement).form) {
        const form = (target as HTMLInputElement).form!;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      } else if (['button', 'a', 'summary'].includes(target.localName) || attr(target, 'role') === 'button' || attr(target, 'role') === 'link') {
        (target as HTMLElement).click();
      }
      return;
    }
    case ' ':
      if (editable) insertText(target, ' ');
      else if (['button', 'summary'].includes(target.localName) || (target.localName === 'input' && ['checkbox', 'radio', 'button', 'submit', 'reset'].includes((target as HTMLInputElement).type))) (target as HTMLElement).click();
      else (scrollContainerAtCenter() ?? document.scrollingElement)?.scrollBy({ top: (mods.has('Shift') ? -0.8 : 0.8) * innerHeight });
      return;
    case 'Tab':
      moveFocus(mods.has('Shift'));
      return;
    case 'Backspace':
    case 'Delete':
      if (editable) {
        const control = target.localName === 'input' || target.localName === 'textarea' ? (target as HTMLInputElement) : null;
        const before = control ? control.value : target.textContent;
        try {
          document.execCommand(key === 'Backspace' ? 'delete' : 'forwardDelete', false);
        } catch {
          // fall through to manual edit
        }
        const after = control ? control.value : target.textContent;
        if (control && before === after) {
          const start = control.selectionStart ?? control.value.length;
          const end = control.selectionEnd ?? start;
          const from = start === end ? (key === 'Backspace' ? Math.max(0, start - 1) : start) : start;
          const to = start === end ? (key === 'Backspace' ? start : Math.min(control.value.length, end + 1)) : end;
          setNativeValue(control, control.value.slice(0, from) + control.value.slice(to));
          control.setSelectionRange(from, from);
          fireInput(control, null, key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward');
        }
      }
      return;
    case 'PageDown':
    case 'PageUp':
    case 'Home':
    case 'End':
    case 'ArrowDown':
    case 'ArrowUp':
      if (!editable) {
        const scroller = scrollContainerAtCenter() ?? document.scrollingElement;
        if (!scroller) return;
        const page = innerHeight * 0.8;
        const delta = key === 'PageDown' ? page : key === 'PageUp' ? -page : key === 'ArrowDown' ? 40 : key === 'ArrowUp' ? -40 : 0;
        if (key === 'Home') scroller.scrollTo({ top: 0 });
        else if (key === 'End') scroller.scrollTo({ top: scroller.scrollHeight });
        else scroller.scrollBy({ top: delta });
      }
      return;
    default:
      if (producesText(press) && editable) insertText(target, press.def.text === '\r' ? '\n' : press.def.text!);
  }
}

function domPress(key: string): { target: string } {
  const press = parseKeyCombo(key);
  const target = deepActiveElement() ?? document.body ?? document.documentElement;
  const modifierDefs = press.modifiers.map((m) => parseKeyCombo(m).def);
  for (const def of modifierDefs) dispatchKey(target, 'keydown', { modifiers: press.modifiers, def });
  const proceed = dispatchKey(target, 'keydown', press);
  let defaultAllowed = proceed;
  if (proceed && producesText(press)) {
    defaultAllowed = dispatchKey(target, 'keypress', press, { charCode: (press.def.text ?? '').charCodeAt(0) } as KeyboardEventInit);
  }
  if (defaultAllowed) defaultKeyAction(press, target);
  dispatchKey(target, 'keyup', press);
  for (const def of modifierDefs.reverse()) dispatchKey(target, 'keyup', { modifiers: [], def });
  return { target: describe(target) };
}

// ---------------------------------------------------------------------------------------------
// Forms, scrolling, waiting
// ---------------------------------------------------------------------------------------------

function selectOptions(ref: string, values: string[]): { selected: string[] } {
  const el = resolve(ref);
  if (el.localName !== 'select') {
    throw new Error(`Element ${ref} is ${describe(el)}, not a native <select>. Click it and then click the desired option instead.`);
  }
  const select = el as HTMLSelectElement;
  const options = Array.from(select.options);
  const matched = values.map((v) => {
    const wanted = v.trim();
    return options.find((o) => o.value === wanted)
      ?? options.find((o) => collapse(o.label || o.text) === wanted)
      ?? options.find((o) => collapse(o.label || o.text).toLowerCase() === wanted.toLowerCase());
  });
  const missing = values.filter((_, i) => !matched[i]);
  if (missing.length) {
    const available = options.slice(0, 40).map((o) => collapse(o.label || o.text)).join(' | ');
    throw new Error(`No option matching ${missing.map(quote).join(', ')}. Available: ${available}${options.length > 40 ? ' | …' : ''}`);
  }
  if (!select.multiple && matched.length > 1) throw new Error('This <select> accepts only one value.');
  select.focus({ preventScroll: true });
  for (const option of options) option.selected = matched.includes(option);
  fireInput(select, null, 'insertReplacementText');
  fireChange(select);
  return { selected: matched.map((o) => collapse(o!.label || o!.text)) };
}

function setChecked(ref: string, checked: boolean): { changed: boolean } {
  const el = resolve(ref);
  const isNative = el.localName === 'input' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type);
  const current = isNative ? (el as HTMLInputElement).checked : attr(el, 'aria-checked') === 'true';
  if (current === checked) return { changed: false };
  domClick(ref);
  return { changed: true };
}

interface UploadedFileSpec {
  name: string;
  mimeType: string;
  base64: string;
}

function setFileInput(ref: string, files: UploadedFileSpec[]): { files: string[] } {
  const el = resolve(ref);
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
    throw new Error('Target element is not an <input type="file">.');
  }
  if (!el.multiple && files.length > 1) {
    throw new Error('This file input accepts only a single file.');
  }
  const dt = new DataTransfer();
  for (const spec of files) {
    const binary = atob(spec.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    dt.items.add(new File([bytes], spec.name, { type: spec.mimeType || 'application/octet-stream' }));
  }
  el.files = dt.files;
  fireInput(el, null, 'insertReplacementText');
  fireChange(el);
  return { files: files.map((f) => f.name) };
}

interface DeclarativeWebMcpTool {
  name: string;
  kind: 'declarative';
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  consequentialHint: boolean;
  autoSubmit: boolean;
}

function discoverDeclarativeWebMcp(): DeclarativeWebMcpTool[] {
  const forms = Array.from(document.querySelectorAll<HTMLFormElement>('form[toolname]'));
  const out: DeclarativeWebMcpTool[] = [];
  for (const form of forms) {
    const name = (form.getAttribute('toolname') ?? '').trim();
    if (!name) continue;
    const description = (form.getAttribute('tooldescription') ?? '').trim();
    const autoSubmit = form.hasAttribute('toolautosubmit');
    const method = (form.getAttribute('method') || 'get').toLowerCase();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[name], select[name], textarea[name]'));
    for (const ctrl of controls) {
      const fieldName = ctrl.name.trim();
      if (!fieldName || (ctrl instanceof HTMLInputElement && ['submit', 'button', 'reset', 'image', 'file'].includes(ctrl.type))) {
        continue;
      }
      const desc = ctrl.getAttribute('toolparamdescription') ?? labelText(ctrl) ?? ctrl.getAttribute('placeholder') ?? '';
      if (ctrl instanceof HTMLSelectElement) {
        const vals = Array.from(ctrl.options).map((o) => o.value).filter((v) => v !== '');
        properties[fieldName] = {
          type: 'string',
          ...(vals.length ? { enum: vals } : {}),
          ...(desc ? { description: desc } : {}),
        };
      } else if (ctrl instanceof HTMLInputElement && ctrl.type === 'checkbox') {
        properties[fieldName] = { type: 'boolean', ...(desc ? { description: desc } : {}) };
      } else if (ctrl instanceof HTMLInputElement && (ctrl.type === 'number' || ctrl.type === 'range')) {
        properties[fieldName] = { type: 'number', ...(desc ? { description: desc } : {}) };
      } else {
        properties[fieldName] = { type: 'string', ...(desc ? { description: desc } : {}) };
      }
      if (ctrl.required && !required.includes(fieldName)) required.push(fieldName);
    }

    out.push({
      name,
      kind: 'declarative',
      description,
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
      },
      readOnlyHint: method === 'get' && !autoSubmit,
      consequentialHint: method !== 'get' || autoSubmit,
      autoSubmit,
    });
  }
  return out;
}

function callDeclarativeWebMcp(
  toolName: string,
  args: Record<string, unknown>,
  requireReadOnly: boolean,
  submit?: boolean,
): { found: boolean; blockedReadOnly?: boolean; error?: string; filled?: string[]; submitted?: boolean } {
  const form = Array.from(document.querySelectorAll<HTMLFormElement>('form[toolname]')).find(
    (f) => (f.getAttribute('toolname') ?? '').trim() === toolName,
  );
  if (!form) return { found: false };
  const autoSubmit = form.hasAttribute('toolautosubmit');
  const method = (form.getAttribute('method') || 'get').toLowerCase();
  const isReadOnly = method === 'get' && !autoSubmit && submit !== true;
  if (requireReadOnly && !isReadOnly) {
    return {
      found: true,
      blockedReadOnly: true,
      error: `Declarative WebMCP form "${toolName}" modifies or submits page state and cannot run in read-only mode.`,
    };
  }

  const filled: string[] = [];
  for (const [key, rawVal] of Object.entries(args ?? {})) {
    const controls = Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]'),
    ).filter((c) => c.name === key);
    const ctrl = controls[0];
    if (!ctrl) continue;
    const r = refFor(ctrl);
    if (ctrl instanceof HTMLInputElement && ctrl.type === 'checkbox') {
      setChecked(r, Boolean(rawVal));
    } else if (ctrl instanceof HTMLSelectElement) {
      selectOptions(r, [String(rawVal)]);
    } else {
      setValue(r, String(rawVal ?? ''));
    }
    filled.push(key);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clone = (globalThis as any).cloneInto;
  const detail = typeof clone === 'function' ? clone({ toolName }, window) : { toolName };
  form.dispatchEvent(new CustomEvent('toolactivated', { detail, bubbles: false }));
  const shouldSubmit = submit === true || (submit !== false && autoSubmit);
  if (shouldSubmit) {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  }
  return { found: true, filled, submitted: shouldSubmit };
}

function scrollPage(ref: string | null, direction: string | null, amount: number): { scrollX: number; scrollY: number; atEnd: boolean } {
  const fraction = Number.isFinite(amount) && amount > 0 ? Math.min(amount, 10) : 0.8;
  let scroller: Element | null;
  if (ref) {
    const el = resolve(ref);
    if (!direction) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      return { scrollX, scrollY, atEnd: false };
    }
    scroller = el;
  } else {
    const docScroller = document.scrollingElement ?? document.documentElement;
    const canScrollDoc = docScroller.scrollHeight > docScroller.clientHeight + 1 || docScroller.scrollWidth > docScroller.clientWidth + 1;
    scroller = canScrollDoc ? docScroller : (scrollContainerAtCenter() ?? docScroller);
  }
  const dir = (direction ?? 'down').toLowerCase();
  const dx = dir === 'left' ? -fraction * innerWidth : dir === 'right' ? fraction * innerWidth : 0;
  const dy = dir === 'up' ? -fraction * innerHeight : dir === 'down' ? fraction * innerHeight : 0;
  scroller.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
  const atEnd = dy > 0 ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 : dy < 0 ? scroller.scrollTop <= 0 : false;
  return { scrollX: Math.round(scrollX), scrollY: Math.round(scroller === document.scrollingElement ? scrollY : scroller.scrollTop), atEnd };
}

function hasText(text: string): boolean {
  const body = document.body;
  if (!body) return false;
  if ((body.innerText ?? body.textContent ?? '').includes(text)) return true;
  return hasShadowRoots() && composedText(body).replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' '));
}

function focusRef(ref: string): { focused: string } {
  const el = resolve(ref);
  scrollIntoViewIfNeeded(el);
  focusTarget(el);
  return { focused: describe(deepActiveElement() ?? el) };
}

function describeRef(ref: string): { description: string } {
  return { description: describe(resolve(ref)) };
}

function descendants(root: Document | Element | ShadowRoot): Element[] {
  const elements: Element[] = [];
  const seen = new Set<Element>();
  const visit = (parent: Document | Element | ShadowRoot) => {
    const children = parent instanceof Element ? childNodesOf(parent) : Array.from(parent.childNodes);
    for (const child of children) {
      if (!(child instanceof Element) || seen.has(child)) continue;
      seen.add(child);
      elements.push(child);
      if (elements.length > 50_000) throw new Error('Locator search exceeds 50000 elements. Narrow the scope with a CSS locator.');
      visit(child);
    }
  };
  visit(root);
  return elements;
}

function locatorText(el: Element): string {
  if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) return el.value;
  const parts: string[] = [];
  const walk = (node: Element) => {
    if (SKIP_TAGS.has(node.localName)) return;
    for (const child of childNodesOf(node)) {
      if (child.nodeType === Node.TEXT_NODE) parts.push(child.nodeValue ?? '');
      else if (child instanceof Element) walk(child);
    }
  };
  walk(el);
  return collapse(parts.join(''));
}

function textMatches(actual: string, expected: string, exact = false): boolean {
  const value = collapse(actual);
  const wanted = collapse(expected);
  return exact ? value === wanted : value.toLowerCase().includes(wanted.toLowerCase());
}

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
  if (style.display === 'contents') return descendants(el).some(isVisible);
  return Array.from(el.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

function roleVisible(el: Element): boolean {
  for (let node: Node | null = el; node; node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)) {
    if (node instanceof Element && attr(node, 'aria-hidden') === 'true') return false;
  }
  return isVisible(el);
}

function matchesStep(el: Element, step: Exclude<LocatorStep, { kind: 'nth' }>): boolean {
  switch (step.kind) {
    case 'css': return el.matches(step.value);
    case 'role': {
      const role = computeRole(el);
      return role === step.value && (step.includeHidden || roleVisible(el)) &&
        (step.name === undefined || textMatches(accessibleName(el, role, Number.MAX_SAFE_INTEGER), step.name, step.exact));
    }
    case 'text': case 'filter': return !SKIP_TAGS.has(el.localName) && textMatches(locatorText(el), step.value, step.kind === 'text' && step.exact);
    case 'label': {
      const labelledBy = attr(el, 'aria-labelledby');
      const label = labelledBy || el.hasAttribute('aria-label') ? accessibleName(el, computeRole(el) ?? '', Number.MAX_SAFE_INTEGER) : labelText(el);
      return Boolean(label) && textMatches(label, step.value, step.exact);
    }
    case 'placeholder': return el.hasAttribute('placeholder') && textMatches(attr(el, 'placeholder')!, step.value, step.exact);
    case 'testId': return attr(el, 'data-testid') === step.value;
    case 'altText': return el.hasAttribute('alt') && textMatches(attr(el, 'alt')!, step.value, step.exact);
    case 'title': return el.hasAttribute('title') && textMatches(attr(el, 'title')!, step.value, step.exact);
  }
}

function findElements(query: Locator): Element[] {
  const locator = parseLocator(query);
  for (const step of locator.steps) {
    if (step.kind === 'css') document.createDocumentFragment().querySelector(step.value);
  }
  let scopes: Array<Document | Element> = [document];
  for (const step of locator.steps) {
    if (step.kind === 'nth') {
      const index = step.index === -1 ? scopes.length - 1 : step.index;
      scopes = scopes[index] ? [scopes[index]] : [];
      continue;
    }
    if (step.kind === 'filter') {
      scopes = scopes.filter((el): el is Element => el instanceof Element && matchesStep(el, step));
      continue;
    }
    const found = new Set<Element>();
    for (const scope of scopes) {
      if (step.kind === 'css') {
        for (const el of scope.querySelectorAll(step.value)) found.add(el);
        if (scope instanceof Element && shadowRootOf(scope)) {
          for (const el of shadowRootOf(scope)!.querySelectorAll(step.value)) found.add(el);
        }
        if (hasShadowRoots()) {
          for (const el of descendants(scope)) {
            const shadow = shadowRootOf(el);
            if (shadow) {
              for (const match of shadow.querySelectorAll(step.value)) found.add(match);
            }
          }
        }
      } else {
        const candidates = descendants(scope);
        const matches = candidates.filter((el) => matchesStep(el, step));
        for (const el of matches) {
          if (step.kind !== 'text' || !matches.some((child) => child !== el && isShadowIncludingDescendant(el, child))) found.add(el);
        }
      }
    }
    scopes = [...found];
  }
  return scopes.filter((el): el is Element => el instanceof Element);
}

function checkedValue(el: Element): boolean | null {
  if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) return el.checked;
  const checked = attr(el, 'aria-checked');
  return checked === null ? null : checked === 'true';
}

function summarizeElement(el: Element): ElementSummary {
  const role = computeRole(el);
  return {
    ref: refFor(el), tag: el.localName, role, name: accessibleName(el, role ?? ''),
    text: truncate(locatorText(el), 300), visible: isVisible(el), enabled: !isDisabled(el),
    editable: locatorEditable(el), checked: checkedValue(el),
  };
}

function locatorEditable(el: Element): boolean {
  const valueInput = el instanceof HTMLInputElement && VALUE_INPUT_TYPES.has(el.type) && !el.readOnly;
  return (isEditable(el) || valueInput) && !isDisabled(el) && attr(el, 'aria-readonly') !== 'true';
}

function locate(locator: Locator, limit = 20): LocatedElements {
  const matches = findElements(locator);
  const max = Math.max(1, Math.min(100, limit));
  return { count: matches.length, elements: matches.slice(0, max).map(summarizeElement), truncated: matches.length > max };
}

function queryElement(ref: string | null, locator: Locator | null, operation: string, attribute: string | null, maxChars = 20000): { value: unknown; truncated?: boolean } {
  const matches = ref ? [resolve(ref)] : locator ? findElements(locator) : [];
  if (operation === 'count') return { value: matches.length };
  if (matches.length > 1) throw new Error(`Strict locator matched ${matches.length} elements. Refine it or use nth/first/last.`);
  const el = matches[0];
  if (operation === 'isVisible' || operation === 'isHidden') {
    const visible = Boolean(el && isVisible(el));
    return { value: operation === 'isVisible' ? visible : !visible };
  }
  if (!el) throw new Error('No element matches the locator.');
  let value: unknown;
  switch (operation) {
    case 'inspect': return { value: summarizeElement(el) };
    case 'innerText': value = el instanceof HTMLElement ? el.innerText : el.textContent; break;
    case 'textContent': value = el.textContent; break;
    case 'inputValue':
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        value = el instanceof HTMLInputElement && el.type === 'password' ? (el.value ? '[masked]' : '') : el.value;
      } else if (isContentEditable(el)) {
        value = el instanceof HTMLElement ? el.innerText : (el.textContent ?? '');
      } else {
        throw new Error('inputValue requires an input, textarea, select or contenteditable element.');
      }
      break;
    case 'getAttribute':
      if (!attribute || !/^[^\s"'<>/=]+$/.test(attribute)) throw new Error('getAttribute requires a valid attribute name.');
      value = el.getAttribute(attribute);
      if (el instanceof HTMLInputElement && el.type === 'password' && attribute.toLowerCase() === 'value' && value) value = '[masked]';
      break;
    case 'isEnabled': value = !isDisabled(el); break;
    case 'isDisabled': value = isDisabled(el); break;
    case 'isEditable': value = locatorEditable(el); break;
    case 'isChecked':
      value = checkedValue(el);
      if (value === null) throw new Error('isChecked requires a checkbox, radio or aria-checked element.');
      break;
    default: throw new Error(`Unsupported element operation "${operation}".`);
  }
  const limit = Math.max(1, Math.min(100_000, maxChars));
  return typeof value === 'string' ? { value: value.slice(0, limit), truncated: value.length > limit } : { value };
}

function elementState(ref: string | null, locator: Locator | null, state: string): { matches: boolean; count: number; ref?: string } {
  if (ref && !refToElement.has(ref)) throw new Error(`Element ref "${ref}" is stale or unknown. Use a locator to wait across document changes.`);
  const matches = ref ? [refToElement.get(ref)?.deref()].filter((el): el is Element => Boolean(el?.isConnected)) : locator ? findElements(locator) : [];
  if (matches.length > 1) throw new Error(`Strict locator matched ${matches.length} elements. Refine it or use nth/first/last.`);
  const el = matches[0];
  let matched: boolean;
  switch (state) {
    case 'attached': matched = Boolean(el); break;
    case 'detached': matched = !el; break;
    case 'visible': matched = Boolean(el && isVisible(el)); break;
    case 'hidden': matched = !el || !isVisible(el); break;
    case 'enabled': matched = Boolean(el && !isDisabled(el)); break;
    case 'disabled': matched = Boolean(el && isDisabled(el)); break;
    case 'editable': matched = Boolean(el && locatorEditable(el)); break;
    case 'checked': case 'unchecked':
      if (el && checkedValue(el) === null) throw new Error(`${state} requires a checkbox, radio or aria-checked element.`);
      matched = Boolean(el && checkedValue(el) === (state === 'checked'));
      break;
    default: throw new Error(`Unsupported element state "${state}".`);
  }
  return { matches: matched, count: matches.length, ...(el ? { ref: refFor(el) } : {}) };
}

function queryAll(locator: Locator, operation: string, attribute: string | null): { values: unknown[]; count: number; truncated: boolean } {
  const matches = findElements(locator);
  const values: unknown[] = [];
  let used = 0;
  let truncated = false;
  for (const el of matches) {
    const item = queryElement(refFor(el), null, operation, attribute, 100_000);
    used += typeof item.value === 'string' ? item.value.length : 4;
    if (used > 500_000 || values.length >= 10_000) {
      truncated = true;
      break;
    }
    values.push(item.value);
    truncated ||= item.truncated === true;
  }
  return { values, count: matches.length, truncated };
}

let handoffHost: HTMLElement | null = null;
let demoCleanup: (() => void) | null = null;
let demoSteps: RecordedStep[] = [];

const MAIN_CONTENT_SELECTOR = "main, [role='main'], article, #search, #rso, #rcnt, #content";

export interface DomQuietOptions {
  maxWaitMs?: number;
  quietMs?: number;
  selector?: string;
  minChars?: number;
}

export interface DomQuietResult {
  settled: boolean;
  waitedMs: number;
  reason: 'already_ready' | 'selector' | 'quiet' | 'cap';
  contentChars: number;
  mainChars: number;
}

function isBridgeOverlayElement(el: Element): boolean {
  if (el === handoffHost) return true;
  if (el.id === '__bb_handoff_host__') return true;
  return typeof el.hasAttribute === 'function' && el.hasAttribute('data-bb-overlay');
}

function isInsideBridgeOverlay(node: Node | null): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === 1 && isBridgeOverlayElement(cur as Element)) return true;
    cur = cur.parentNode ?? (cur as ShadowRoot).host ?? null;
  }
  return false;
}

function fastTextChars(root: Element | null | undefined): number {
  if (!root || isBridgeOverlayElement(root)) return 0;
  const sr = shadowRootOf(root);
  if ((!root.childNodes || root.childNodes.length === 0) && (!sr || !sr.childNodes || sr.childNodes.length === 0)) {
    return collapse(root.textContent).length;
  }
  const parts: string[] = [];
  const walk = (node: Element | ShadowRoot) => {
    for (const child of childNodesOf(node)) {
      if (child.nodeType === 3) {
        if (child.nodeValue) parts.push(child.nodeValue);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = (el.localName || el.tagName || '').toLowerCase();
      if (SKIP_TAGS.has(tag) || isBridgeOverlayElement(el)) continue;
      if (typeof el.hasAttribute === 'function' && el.hasAttribute('hidden')) continue;
      walk(el);
    }
  };
  walk(root);
  return collapse(parts.join(' ')).length;
}

export function measureContent(): { contentChars: number; mainChars: number } {
  const body = document.body ?? document.documentElement;
  const contentChars = fastTextChars(body);
  let mainEl: Element | null = null;
  try {
    mainEl = typeof document.querySelector === 'function' ? document.querySelector(MAIN_CONTENT_SELECTOR) : null;
  } catch {
    mainEl = null;
  }
  const mainChars = mainEl ? fastTextChars(mainEl) : 0;
  return { contentChars, mainChars };
}

function isIntrinsicNonTextLandmark(el: Element): boolean {
  if (el.hasAttribute?.('hidden') || el.getAttribute?.('aria-hidden') === 'true') return false;
  const tag = (el.localName ?? el.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'canvas') {
    const typeAttr = (el.getAttribute?.('type') ?? '').toLowerCase();
    return typeAttr !== 'hidden' && !(el as HTMLInputElement).disabled;
  }
  const ce = el.getAttribute?.('contenteditable');
  return ce === '' || ce === 'true' || ce === 'plaintext-only';
}

const VISUAL_LANDMARK_TAGS = new Set(['img', 'svg', 'video', 'iframe', 'embed', 'object', 'canvas']);

function elementLandmarkReady(el: Element, allowLayoutRead = true): boolean {
  if (isBridgeOverlayElement(el)) return false;
  if (fastTextChars(el) > 0) return true;
  if (isIntrinsicNonTextLandmark(el)) return true;
  if (allowLayoutRead && typeof el.getBoundingClientRect === 'function') {
    const tag = (el.localName ?? el.tagName ?? '').toLowerCase();
    if (VISUAL_LANDMARK_TAGS.has(tag) || tag.includes('-')) {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width > 0 && (rect.height === undefined || rect.height > 0)) return true;
    }
  }
  return false;
}

export function selectorReady(sel?: string, allowLayoutRead = true): boolean {
  const trimmed = typeof sel === 'string' ? sel.trim() : '';
  if (!trimmed) return false;
  try {
    if (typeof document.querySelectorAll === 'function') {
      const matches = document.querySelectorAll(trimmed);
      const limit = Math.min(matches.length, 8);
      for (let i = 0; i < limit; i++) {
        const el = matches[i];
        if (el && elementLandmarkReady(el, allowLayoutRead)) return true;
      }
      return false;
    }
    const single = typeof document.querySelector === 'function' ? document.querySelector(trimmed) : null;
    return Boolean(single && elementLandmarkReady(single, allowLayoutRead));
  } catch {
    return false;
  }
}

function isRelevantMutationBatch(records: MutationRecord[]): boolean {
  for (const rec of records) {
    if (isInsideBridgeOverlay(rec.target)) continue;
    if (rec.type === 'childList') {
      const added = rec.addedNodes ? Array.from(rec.addedNodes) : [];
      const removed = rec.removedNodes ? Array.from(rec.removedNodes) : [];
      if (
        added.length + removed.length > 0 &&
        [...added, ...removed].every((n) => n.nodeType === 1 && isBridgeOverlayElement(n as Element))
      ) {
        continue;
      }
    }
    return true;
  }
  return false;
}

export function waitForDomQuiet(options?: DomQuietOptions): Promise<DomQuietResult> {
  const rawMax = Number(options?.maxWaitMs ?? 0);
  const maxWaitMs = Math.max(0, Math.min(Number.isFinite(rawMax) ? rawMax : 0, 600));
  const rawQuiet = Number(options?.quietMs ?? 75);
  const quietMs = Math.max(20, Math.min(Number.isFinite(rawQuiet) ? rawQuiet : 75, 300));
  const rawMinChars = Number(options?.minChars ?? 64);
  const minChars = Math.max(0, Number.isFinite(rawMinChars) ? rawMinChars : 64);
  const selector = typeof options?.selector === 'string' && options.selector.trim() ? options.selector.trim() : undefined;

  if (maxWaitMs <= 0) {
    return Promise.resolve({ settled: true, waitedMs: 0, reason: 'already_ready', ...measureContent() });
  }
  if (selector && selectorReady(selector)) {
    return Promise.resolve({ settled: true, waitedMs: 0, reason: 'selector', ...measureContent() });
  }
  if (!document.documentElement || typeof MutationObserver !== 'function') {
    return Promise.resolve({ settled: true, waitedMs: 0, reason: 'already_ready', ...measureContent() });
  }

  const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
  const startedAt = nowMs();
  const emptyGraceMs = Math.min(maxWaitMs, 150);

  return new Promise<DomQuietResult>((resolvePromise) => {
    let done = false;
    let lastActivityAt = startedAt;
    let observer: MutationObserver | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    let onReadyState: (() => void) | null = null;

    const cleanup = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      if (capTimer !== null) {
        clearTimeout(capTimer);
        capTimer = null;
      }
      if (onReadyState && typeof document.removeEventListener === 'function') {
        document.removeEventListener('readystatechange', onReadyState);
        onReadyState = null;
      }
    };

    const finish = (
      settled: boolean,
      reason: DomQuietResult['reason'],
      preMeasured?: { contentChars: number; mainChars: number },
    ) => {
      if (done) return;
      done = true;
      cleanup();
      const metrics = preMeasured ?? measureContent();
      const waitedMs = Math.max(0, Math.min(maxWaitMs, Math.round(nowMs() - startedAt)));
      resolvePromise({
        settled,
        waitedMs,
        reason,
        contentChars: metrics.contentChars,
        mainChars: metrics.mainChars,
      });
    };

    const armQuietTimer = (delayMs: number) => {
      if (done) return;
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(onQuietCheck, Math.max(1, Math.round(delayMs)));
    };

    const onQuietCheck = () => {
      if (done) return;
      quietTimer = null;
      if (selector && selectorReady(selector)) {
        finish(true, 'selector');
        return;
      }
      const now = nowMs();
      const quietFor = now - lastActivityAt;
      if (quietFor + 1 < quietMs) {
        armQuietTimer(quietMs - quietFor);
        return;
      }
      if (document.readyState === 'loading') {
        armQuietTimer(Math.min(quietMs, 25));
        return;
      }
      const elapsed = now - startedAt;
      const measured = measureContent();
      if (measured.contentChars >= minChars || elapsed + 1 >= emptyGraceMs) {
        finish(true, 'quiet', measured);
        return;
      }
      armQuietTimer(Math.max(10, emptyGraceMs - elapsed));
    };

    observer = new MutationObserver((records) => {
      if (done) return;
      if (!isRelevantMutationBatch(records)) return;
      if (selector && selectorReady(selector, false)) {
        finish(true, 'selector');
        return;
      }
      lastActivityAt = nowMs();
      armQuietTimer(quietMs);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      onReadyState = () => {
        if (done) return;
        if (selector && selectorReady(selector)) {
          finish(true, 'selector');
        } else if (nowMs() - lastActivityAt + 1 >= quietMs) {
          onQuietCheck();
        }
      };
      document.addEventListener('readystatechange', onReadyState);
    }

    armQuietTimer(quietMs);
    capTimer = setTimeout(() => {
      if (selector && selectorReady(selector)) {
        finish(true, 'selector');
      } else {
        finish(false, 'cap');
      }
    }, maxWaitMs);
  });
}

export function detectChallengeMarkers(): {
  title: string;
  url: string;
  textSample: string;
  markers: string[];
  contentChars: number;
  mainChars: number;
} {
  const markers: string[] = [];
  if (
    document.querySelector(
      '.cf-turnstile, #challenge-running, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"]',
    )
  ) {
    markers.push('cloudflare-turnstile');
  }
  if (document.querySelector('.g-recaptcha, iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"]')) {
    markers.push('recaptcha');
  }
  if (document.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]')) {
    markers.push('hcaptcha');
  }
  if (document.querySelector('iframe[src*="arkoselabs.com"], iframe[src*="funcaptcha.com"]')) {
    markers.push('arkose');
  }
  if (document.querySelector('iframe[src*="captcha-delivery.com"]')) {
    markers.push('datadome');
  }
  const { contentChars, mainChars } = measureContent();
  const textSample = truncate(collapse(document.body?.innerText ?? document.body?.textContent ?? ''), 1200);
  return { title: document.title ?? '', url: location.href, textSample, markers, contentChars, mainChars };
}

// ---------------------------------------------------------------------------------------------
// Closed-ShadowRoot Handoff Card & Demonstrate-to-Routine Recorder
// ---------------------------------------------------------------------------------------------

interface RecordedStep {
  op: string;
  params: Record<string, unknown>;
}

function sendRuntimeMessage(payload: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = (globalThis as any).browser?.runtime ?? (globalThis as any).chrome?.runtime;
    rt?.sendMessage?.(payload)?.catch?.(() => undefined);
  } catch {
    // ignore
  }
}

function hideHandoffCard(): { hidden: boolean } {
  if (handoffHost) {
    handoffHost.remove();
    handoffHost = null;
  }
  return { hidden: true };
}

function showHandoffCard(options: {
  id: string;
  origin: string;
  message: string;
  continueLabel?: string;
  cancelLabel?: string;
}): { shown: boolean } {
  hideHandoffCard();
  const host = document.createElement('div');
  host.setAttribute('data-bb-overlay', 'handoff');
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:auto;';
  const shadow = host.attachShadow({ mode: 'closed', delegatesFocus: true });

  const style = document.createElement('style');
  style.textContent = `
    .card {
      width: 320px;
      contain: layout style paint;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #18191c;
      color: #f3f4f6;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 12px;
      padding: 14px 15px;
      box-shadow: 0 14px 34px rgba(0,0,0,0.38);
    }
    .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; font-weight: 600; color: #fbbf24;
      background: rgba(245, 158, 11, 0.16); padding: 2px 8px; border-radius: 999px;
    }
    .origin { font-size: 11px; color: #9ca3af; max-width: 155px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .msg { margin: 8px 0 12px; color: #e5e7eb; word-break: break-word; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    button {
      cursor: pointer; border-radius: 8px; padding: 6px 13px; min-block-size: 28px; min-inline-size: 28px; font-size: 12px; font-weight: 600; border: 1px solid transparent;
    }
    button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
    .btn-cancel { background: rgba(255,255,255,0.08); color: #d1d5db; border-color: rgba(255,255,255,0.12); }
    .btn-cancel:hover { background: rgba(255,255,255,0.14); }
    .btn-go { background: #2563eb; color: #ffffff; }
    .btn-go:hover { background: #1d4ed8; }
  `;

  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'head';
  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.textContent = '● Browser Bridge · WAIT';
  const originEl = document.createElement('span');
  originEl.className = 'origin';
  originEl.textContent = options.origin || location.hostname;
  head.append(pill, originEl);

  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = options.message || 'Complete the step in this tab, then click Continue.';

  const actions = document.createElement('div');
  actions.className = 'actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.type = 'button';
  cancelBtn.textContent = options.cancelLabel || 'Cancel';
  const goBtn = document.createElement('button');
  goBtn.className = 'btn-go';
  goBtn.type = 'button';
  goBtn.textContent = options.continueLabel || 'Continue';

  cancelBtn.addEventListener('click', (ev) => {
    if (!ev.isTrusted) return;
    hideHandoffCard();
    sendRuntimeMessage({ type: 'content:handoff', id: options.id, action: 'cancel' });
  });
  goBtn.addEventListener('click', (ev) => {
    if (!ev.isTrusted) return;
    hideHandoffCard();
    sendRuntimeMessage({ type: 'content:handoff', id: options.id, action: 'continue' });
  });

  actions.append(cancelBtn, goBtn);
  card.append(head, msg, actions);
  shadow.append(style, card);
  (document.documentElement || document.body).appendChild(host);
  handoffHost = host;
  return { shown: true };
}

function isSensitiveInput(el: Element): boolean {
  if (el.localName === 'input') {
    const inp = el as HTMLInputElement;
    const t = (inp.type || 'text').toLowerCase();
    if (t === 'password' || t === 'hidden') return true;
    const ac = (inp.autocomplete || '').toLowerCase();
    if (/password|one-time-code|cc-number|cc-csc|cc-exp/.test(ac)) return true;
  }
  const meta = `${attr(el, 'name') ?? ''} ${el.id ?? ''} ${attr(el, 'aria-label') ?? ''}`.toLowerCase();
  return /passw|otp|totp|cvv|cvc|pin[-_]?code/.test(meta);
}

function synthesizeLocator(el: Element): Locator {
  const testId = attr(el, 'data-testid');
  if (testId) {
    const cand: Locator = { steps: [{ kind: 'testId', value: testId }] };
    if (findElements(cand).length === 1) return cand;
  }
  const role = computeRole(el);
  if (role && role !== 'generic') {
    const name = accessibleName(el, role, 120);
    if (name) {
      const cand: Locator = { steps: [{ kind: 'role', value: role, name, exact: true }] };
      const matches = findElements(cand);
      if (matches.length === 1) return cand;
      const idx = matches.indexOf(el);
      if (idx >= 0 && matches.length <= 6) {
        return { steps: [{ kind: 'role', value: role, name, exact: true }, { kind: 'nth', index: idx }] };
      }
    }
  }
  const lbl = labelText(el);
  if (lbl) {
    const cand: Locator = { steps: [{ kind: 'label', value: lbl, exact: true }] };
    if (findElements(cand).length === 1) return cand;
  }
  const placeholder = attr(el, 'placeholder');
  if (placeholder) {
    const cand: Locator = { steps: [{ kind: 'placeholder', value: placeholder, exact: true }] };
    if (findElements(cand).length === 1) return cand;
  }
  if (el.id && !/^\d|[:\s]/.test(el.id) && el.id.length <= 48) {
    const sel = `#${CSS.escape(el.id)}`;
    const cand: Locator = { steps: [{ kind: 'css', value: sel }] };
    if (findElements(cand).length === 1) return cand;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement && parts.length < 4) {
    let seg = cur.localName;
    if (cur.id && !/^\d/.test(cur.id) && cur.id.length <= 40) {
      seg = `#${CSS.escape(cur.id)}`;
      parts.unshift(seg);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const tagName = cur.localName;
      const sameTag = Array.from(parent.children).filter((c: Element) => c.localName === tagName);
      if (sameTag.length > 1) {
        seg += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
    }
    parts.unshift(seg);
    cur = parent;
  }
  return { steps: [{ kind: 'css', value: parts.join(' > ') || el.localName }] };
}

function actionMeta(ref: string, includeLocator = true): { locator?: Locator; sensitive: boolean; label: string } {
  const el = resolve(ref);
  const role = computeRole(el);
  const label = (
    (role && role !== 'generic' ? accessibleName(el, role, 80) : '') ||
    labelText(el) ||
    attr(el, 'placeholder') ||
    attr(el, 'data-testid') ||
    el.id ||
    el.localName
  ).trim();
  return {
    ...(includeLocator ? { locator: synthesizeLocator(el) } : {}),
    sensitive: isSensitiveInput(el),
    label,
  };
}

function stopDemoRecorder(): { stopped: boolean; steps: RecordedStep[] } {
  if (demoCleanup) {
    demoCleanup();
    demoCleanup = null;
  }
  return { stopped: true, steps: [...demoSteps] };
}

function startDemoRecorder(options: {
  id: string;
  instruction?: string;
  finishLabel?: string;
  cancelLabel?: string;
}): { started: boolean } {
  stopDemoRecorder();
  demoSteps = [];

  const host = document.createElement('div');
  host.setAttribute('data-bb-overlay', 'demonstrate');
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:auto;';
  const shadow = host.attachShadow({ mode: 'closed', delegatesFocus: true });

  const style = document.createElement('style');
  style.textContent = `
    .bar {
      width: 310px;
      contain: layout style paint;
      font: 12.5px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #18191c; color: #f3f4f6;
      border: 1px solid rgba(239,68,68,0.45); border-radius: 12px;
      padding: 11px 13px; box-shadow: 0 12px 30px rgba(0,0,0,0.38);
    }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .rec { color: #f87171; font-weight: 700; font-size: 12px; }
    .hint { margin: 6px 0 10px; color: #d1d5db; font-size: 12px; }
    .btns { display: flex; gap: 8px; justify-content: flex-end; }
    button { cursor: pointer; border-radius: 7px; padding: 5px 11px; min-block-size: 28px; min-inline-size: 28px; font-size: 12px; font-weight: 600; border: 1px solid transparent; }
    button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
    .cancel { background: rgba(255,255,255,0.08); color: #d1d5db; }
    .finish { background: #10b981; color: #052e16; }
  `;

  const bar = document.createElement('div');
  bar.className = 'bar';
  const top = document.createElement('div');
  top.className = 'top';
  const recLabel = document.createElement('span');
  recLabel.className = 'rec';
  recLabel.textContent = '● Recording (0 steps)';
  top.appendChild(recLabel);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = options.instruction || 'Perform the workflow on this page, then click Finish to save as a fast Routine.';

  const btns = document.createElement('div');
  btns.className = 'btns';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel';
  cancelBtn.type = 'button';
  cancelBtn.textContent = options.cancelLabel || 'Cancel';
  const finishBtn = document.createElement('button');
  finishBtn.className = 'finish';
  finishBtn.type = 'button';
  finishBtn.textContent = options.finishLabel || 'Finish & Save';
  btns.append(cancelBtn, finishBtn);
  bar.append(top, hint, btns);
  shadow.append(style, bar);
  (document.documentElement || document.body).appendChild(host);

  const syncCount = () => {
    recLabel.textContent = `● Recording (${demoSteps.length} step${demoSteps.length === 1 ? '' : 's'})`;
    sendRuntimeMessage({ type: 'content:demoProgress', id: options.id, steps: demoSteps });
  };

  const pushStep = (step: RecordedStep) => {
    if (demoSteps.length >= 60) return;
    const prev = demoSteps[demoSteps.length - 1];
    if (
      prev &&
      prev.op === 'type' &&
      step.op === 'type' &&
      JSON.stringify(prev.params.locator) === JSON.stringify(step.params.locator)
    ) {
      prev.params.text = step.params.text;
    } else {
      demoSteps.push(step);
    }
    syncCount();
  };

  const actionableAncestor = (raw: EventTarget | null): Element | null => {
    if (!(raw instanceof Element)) return null;
    if (host.contains(raw)) return null;
    return (
      raw.closest('button, a, input, textarea, select, summary, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [contenteditable="true"]') ??
      raw
    );
  };

  const onClick = (ev: MouseEvent) => {
    if (!ev.isTrusted) return;
    const el = actionableAncestor(ev.target);
    if (!el) return;
    if (el.localName === 'input') {
      const inp = el as HTMLInputElement;
      const t = (inp.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return; // handled in change
      if (!['button', 'submit', 'reset', 'file', 'image'].includes(t)) return; // focus click on text field
    }
    if (el.localName === 'textarea' || el.localName === 'select' || isContentEditable(el)) return;
    pushStep({ op: 'click', params: { locator: synthesizeLocator(el) } });
  };

  const onDblClick = (ev: MouseEvent) => {
    if (!ev.isTrusted) return;
    const el = actionableAncestor(ev.target);
    if (!el) return;
    pushStep({ op: 'doubleClick', params: { locator: synthesizeLocator(el) } });
  };

  const onChange = (ev: Event) => {
    if (!ev.isTrusted) return;
    const el = ev.target instanceof Element ? ev.target : null;
    if (!el || host.contains(el) || isSensitiveInput(el)) return;
    const locator = synthesizeLocator(el);
    if (el.localName === 'select') {
      const vals = Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.value || o.label);
      pushStep({ op: 'select', params: { locator, values: vals } });
    } else if (el.localName === 'input' && ['checkbox', 'radio'].includes(((el as HTMLInputElement).type || '').toLowerCase())) {
      pushStep({ op: 'check', params: { locator, checked: (el as HTMLInputElement).checked } });
    } else if (el.localName === 'input' || el.localName === 'textarea') {
      pushStep({ op: 'type', params: { locator, text: (el as HTMLInputElement).value, clear: true } });
    }
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (!ev.isTrusted) return;
    const el = ev.target instanceof Element ? ev.target : null;
    if (el && (host.contains(el) || isSensitiveInput(el))) return;
    if (ev.key === 'Enter' || ev.key === 'Escape') {
      if (el && (el.localName === 'input' || el.localName === 'textarea') && !isSensitiveInput(el)) {
        const val = (el as HTMLInputElement).value;
        if (val) {
          pushStep({ op: 'type', params: { locator: synthesizeLocator(el), text: val, clear: true } });
        }
      }
      pushStep({ op: 'press', params: { key: ev.key } });
    }
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('dblclick', onDblClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('keydown', onKeyDown, true);

  const teardown = () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dblclick', onDblClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
    host.remove();
  };
  demoCleanup = teardown;

  cancelBtn.addEventListener('click', (ev) => {
    if (!ev.isTrusted) return;
    const snapshotSteps = [...demoSteps];
    stopDemoRecorder();
    sendRuntimeMessage({ type: 'content:demoFinish', id: options.id, action: 'cancel', steps: snapshotSteps });
  });
  finishBtn.addEventListener('click', (ev) => {
    if (!ev.isTrusted) return;
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.localName === 'input' || activeEl.localName === 'textarea') && !isSensitiveInput(activeEl)) {
      const val = (activeEl as HTMLInputElement).value;
      if (val) pushStep({ op: 'type', params: { locator: synthesizeLocator(activeEl), text: val, clear: true } });
    }
    const snapshotSteps = [...demoSteps];
    stopDemoRecorder();
    sendRuntimeMessage({ type: 'content:demoFinish', id: options.id, action: 'finish', steps: snapshotSteps });
  });

  return { started: true };
}

const bb = {
  version: CONTENT_VERSION,
  snapshot,
  getText,
  point: (ref: string) => pointFor(resolve(ref)),
  box: boxFor,
  pageMetrics,
  frameOffset,
  click: domClick,
  hover: domHover,
  drag: domDrag,
  focusForTyping,
  setValue,
  isChecked,
  value: (ref: string) => ({ value: controlValue(resolve(ref)) ?? '' }),
  type: domType,
  press: domPress,
  select: selectOptions,
  setChecked,
  setFileInput,
  discoverDeclarativeWebMcp,
  callDeclarativeWebMcp,
  detectChallengeMarkers,
  waitForDomQuiet,
  showHandoffCard,
  hideHandoffCard,
  startDemoRecorder,
  stopDemoRecorder,
  readDemoSteps: () => ({ steps: [...demoSteps] }),
  scroll: scrollPage,
  hasText,
  focus: focusRef,
  describe: describeRef,
  actionMeta,
  locate,
  queryElement,
  queryAll,
  elementState,
  frameInfo: () => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    userAgent: navigator.userAgent,
    isTop: window === window.top,
    width: innerWidth,
    height: innerHeight,
    navigationTiming: readNavigationTiming(),
  }),
};

export function readNavigationTiming(): {
  ttfbMs: number;
  networkMs: number;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  transferSize: number;
  protocol: string;
} | undefined {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return undefined;
    const ttfbMs = Math.max(0, Math.round(nav.responseStart - nav.startTime));
    const networkMs = Math.max(ttfbMs, Math.round(nav.responseEnd - nav.startTime));
    const domContentLoadedMs =
      nav.domContentLoadedEventEnd > 0 ? Math.max(0, Math.round(nav.domContentLoadedEventEnd - nav.startTime)) : null;
    const loadEventMs =
      nav.loadEventEnd > 0 ? Math.max(0, Math.round(nav.loadEventEnd - nav.startTime)) : null;
    const transferSize =
      typeof nav.transferSize === 'number' && Number.isFinite(nav.transferSize) ? Math.max(0, nav.transferSize) : 0;
    const protocol = typeof nav.nextHopProtocol === 'string' ? nav.nextHopProtocol : '';
    return { ttfbMs, networkMs, domContentLoadedMs, loadEventMs, transferSize, protocol };
  } catch {
    return undefined;
  }
}

export type ContentApi = typeof bb;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalScope = globalThis as any;
if (!globalScope.__bb || globalScope.__bb.version !== CONTENT_VERSION) {
  globalScope.__bb = bb;
}
