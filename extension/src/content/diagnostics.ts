import {
  DIAGNOSTICS_LIMITS as L,
  DIAGNOSTICS_STYLE_PROPERTIES,
  type BaselineCaptureInfo, type BaselineChange, type BaselineCompareOptions, type BaselineComparison,
  type BaselineCreateOptions, type BaselineDescriptor, type BaselineNode, type BaselineReleaseResult,
  type BoxEdges, type BoxModelResult, type BoxSize, type ComputedStylesOptions, type ComputedStylesResult,
  type DiagnosticsApi, type DiagnosticsDisposeResult, type DiagnosticsErrorCode, type DiagnosticsHelpers, type HitTestPoint, type HitTestResult,
  type MatchedStyleRule, type RectMeasurement, type ReleaseOwnerResult, type StyleContextResult,
  type StyleDeclaration, type StyleSheetInfo, type Target, type ViewportMeasurement,
} from '../shared/diagnostics.ts';
import type { ElementSummary } from '../shared/locators.ts';

export type * from '../shared/diagnostics.ts';
export { DIAGNOSTICS_LIMITS, DIAGNOSTICS_STYLE_PROPERTIES } from '../shared/diagnostics.ts';

export class DiagnosticsError extends Error {
  constructor(public readonly code: DiagnosticsErrorCode, message: string) {
    super(message);
    this.name = 'DiagnosticsError';
  }
}

const PROPERTIES = new Set(DIAGNOSTICS_STYLE_PROPERTIES);
const DEFAULT_PROPERTIES = [
  'display', 'visibility', 'opacity', 'position', 'z-index', 'width', 'height', 'box-sizing',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'color', 'background-color', 'font-size', 'line-height', 'overflow-x', 'overflow-y',
  'pointer-events', 'transform', 'flex-direction', 'align-items', 'justify-content', 'gap',
];
const PSEUDOS = new Set(['::before', '::after', '::marker', '::placeholder', '::first-letter', '::first-line']);
const EXCLUDED_TAGS = new Set(['script', 'style', 'head', 'meta', 'link', 'template', 'noscript', 'metadata']);
const FORM_TAGS = new Set(['input', 'textarea', 'select', 'option']);
const INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'hidden', 'image', 'month',
  'number', 'password', 'radio', 'range', 'reset', 'search', 'submit', 'tel', 'text', 'time', 'url', 'week',
]);
const BASELINE_NOTES = [
  'Scope is visible semantic light DOM in this document, not HTML or an accessibility tree.',
  'Script, style, hidden branches, arbitrary attributes, URL attributes, and all form/editable values are excluded.',
  'Text and labels are bounded and token-redacted. Roles are explicit DOM roles. Iframe and shadow contents are not read.',
  'Absence in an incomplete capture is unverified. Comparisons do not replace the stored baseline.',
];

interface Sanitized {
  value: string;
  truncated: boolean;
  redacted: boolean;
}

interface Capture {
  nodes: BaselineNode[];
  info: BaselineCaptureInfo;
}

interface StoredBaseline {
  id: string;
  owner: string;
  root: WeakRef<Element>;
  rootRef: string;
  createdAt: number;
  expiresAt: number;
  expiresTick: number;
  maxNodes: number;
  maxText: number;
  capture: Capture;
}

function invalid(message: string): never {
  throw new DiagnosticsError('invalid_argument', message);
}

function object(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) invalid(`Unsupported ${label} property "${key.slice(0, 64)}".`);
  }
  return record;
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function ownerName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    invalid('owner must be a non-empty string of at most 128 characters.');
  }
  return value;
}

function baselineId(value: unknown): string {
  if (typeof value !== 'string' || !/^db_[0-9a-f]{32}$/.test(value)) invalid('Invalid DOM baseline ID.');
  return value;
}

function checkedTarget(target: Target | undefined): Target | undefined {
  if (target === undefined) return undefined;
  const record = object(target, 'target', ['ref', 'locator']);
  if ((record.ref !== undefined) === (record.locator !== undefined)) invalid('target must contain exactly one ref or locator.');
  if (record.ref !== undefined && (typeof record.ref !== 'string' || !record.ref || record.ref.length > 4096)) {
    invalid('target.ref must be a non-empty string of at most 4096 characters.');
  }
  if (record.locator !== undefined && (!record.locator || typeof record.locator !== 'object' || Array.isArray(record.locator))) {
    invalid('target.locator must be an object.');
  }
  return target;
}

function sanitize(value: string, max: number): Sanitized {
  const prefix = value.slice(0, 4096);
  const cleaned = prefix
    .replace(/<[^>]*(?:>|$)/g, '[markup]')
    .replace(/url\([^)]*(?:\)|$)/gi, 'url([redacted])')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi, '[url]')
    .replace(/\b(?:data|blob|javascript|file|mailto|tel):[^\s<>"']+/gi, '[url]')
    .replace(/(?:^|\s)\/[^\s<>"']*%[^\s<>"']*/gi, ' [url]')
    .replace(/(?:\/[^\s<>"']*)?\?[^\s<>"']+|[&#][a-z0-9_.%-]+=[^\s<>"']*/gi, '[query]')
    .replace(/\b(?:bearer|basic)\s+[a-z0-9+/_.=-]+/gi, '[redacted]')
    .replace(/\b(?:password|passwd|pwd|(?:client[-_ ]?)?secret|(?:(?:access|refresh|id|csrf|xsrf|auth|api|session)[-_ ]?)?token|api[-_ ]?key|authorization|cookie|session[-_ ]?id|otp|totp|mfa|pin|verification[-_ ]?code|one[-_ ]?time[-_ ]?code)["']?\s*(?:=|:|\bis\b)\s*["']?[^\s,;"'}]+/gi, '[redacted]')
    .replace(/\b[a-z0-9_.%-]+=[^\s,;"'}]+/gi, '[query]')
    .replace(/\b[a-z0-9_+-]{24,}(?:\.[a-z0-9_+-]+)*\b/gi, '[redacted]')
    .replace(/\s+/g, ' ').trim();
  return {
    value: cleaned.slice(0, max),
    truncated: value.length > 4096 || cleaned.length > max,
    redacted: cleaned !== prefix.replace(/\s+/g, ' ').trim(),
  };
}

function px(value: string): number | null {
  const match = /^(-?(?:\d+(?:\.\d*)?|\.\d+))(?:px)?$/.exec(value.trim());
  if (!match) return null;
  const result = Number(match[1]);
  return Number.isFinite(result) ? result : null;
}

function numeric(value: string): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new DiagnosticsError('unavailable', `${label} is not a finite measurement.`);
  return value;
}

function rect(value: DOMRect): RectMeasurement {
  return {
    x: finite(value.x, 'rect.x'), y: finite(value.y, 'rect.y'),
    top: finite(value.top, 'rect.top'), right: finite(value.right, 'rect.right'),
    bottom: finite(value.bottom, 'rect.bottom'), left: finite(value.left, 'rect.left'),
    width: finite(value.width, 'rect.width'), height: finite(value.height, 'rect.height'),
  };
}

function sum(...values: Array<number | null>): number | null {
  let result = 0;
  for (const value of values) {
    if (value === null) return null;
    result += value;
  }
  return Number.isFinite(result) ? result : null;
}

function subtract(value: number | null, ...values: Array<number | null>): number | null {
  const deduction = sum(...values);
  return value === null || deduction === null ? null : Math.max(0, value - deduction);
}

function parentAcrossShadow(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function copyInfo(info: BaselineCaptureInfo): BaselineCaptureInfo {
  return { ...info, omissions: { ...info.omissions } };
}

export function createDiagnosticsApi(helpers: DiagnosticsHelpers): DiagnosticsApi {
  const doc = document;
  const win = window;
  let documentRoot = doc.documentElement;
  const encoder = new TextEncoder();
  const baselines = new Map<string, StoredBaseline>();
  let totalBytes = 0;
  let disposed = false;
  let documentLost = false;

  function ensureDocument(): void {
    if (disposed) throw new DiagnosticsError('disposed', 'Diagnostics API has been disposed.');
    if (documentLost || document !== doc || win.document !== doc || documentRoot !== null && doc.documentElement !== documentRoot) {
      documentLost = true;
      baselines.clear();
      totalBytes = 0;
      throw new DiagnosticsError('document_replaced', 'The original document was replaced. Create diagnostics in the new document.');
    }
    if (documentRoot === null) documentRoot = doc.documentElement;
  }

  function attached(element: Element): Element {
    if (element.ownerDocument !== doc || !element.isConnected) {
      throw new DiagnosticsError('detached_root', 'The original target/root is detached or belongs to a different document.');
    }
    return element;
  }

  function resolve(target: Target | undefined): Element {
    ensureDocument();
    return attached(helpers.resolveTarget(checkedTarget(target)));
  }

  function ref(element: Element): string {
    const result = helpers.refFor(element);
    if (typeof result !== 'string' || !result || result.length > 128) {
      throw new DiagnosticsError('unavailable', 'Diagnostics requires a bounded stable element ref.');
    }
    return result;
  }

  function summary(element: Element): ElementSummary {
    const result = helpers.summarize(element);
    const form = FORM_TAGS.has(element.localName) || element instanceof HTMLElement && element.isContentEditable;
    return {
      ref: ref(element), tag: element.localName.slice(0, 64),
      role: result.role && /^[a-z][a-z0-9-]{0,63}$/.test(result.role) ? result.role : null,
      name: form ? '' : sanitize(result.name, 256).value,
      text: form || !helpers.isVisible(element) ? '' : sanitize(result.text, 256).value,
      visible: result.visible, enabled: result.enabled, editable: result.editable, checked: result.checked,
    };
  }

  function viewport(): ViewportMeasurement {
    const visual = win.visualViewport;
    return {
      width: finite(win.innerWidth, 'viewport.width'), height: finite(win.innerHeight, 'viewport.height'),
      scrollX: finite(win.scrollX, 'viewport.scrollX'), scrollY: finite(win.scrollY, 'viewport.scrollY'),
      devicePixelRatio: finite(win.devicePixelRatio, 'viewport.devicePixelRatio'),
      visualViewport: visual ? {
        offsetLeft: finite(visual.offsetLeft, 'visualViewport.offsetLeft'), offsetTop: finite(visual.offsetTop, 'visualViewport.offsetTop'),
        pageLeft: finite(visual.pageLeft, 'visualViewport.pageLeft'), pageTop: finite(visual.pageTop, 'visualViewport.pageTop'),
        width: finite(visual.width, 'visualViewport.width'), height: finite(visual.height, 'visualViewport.height'),
        scale: finite(visual.scale, 'visualViewport.scale'),
      } : null,
    };
  }

  function computedStyles(target: Target | undefined, options?: ComputedStylesOptions): ComputedStylesResult {
    if (options !== undefined) object(options, 'computedStyles options', ['properties', 'pseudo']);
    const properties = options?.properties === undefined ? DEFAULT_PROPERTIES : options.properties;
    if (!Array.isArray(properties) || !properties.length || properties.length > L.maxStyleProperties) {
      invalid(`properties must contain 1-${L.maxStyleProperties} supported CSS properties.`);
    }
    const seen = new Set<string>();
    for (const property of properties) {
      if (typeof property !== 'string' || !PROPERTIES.has(property)) invalid('Unsupported diagnostic CSS property. Use DIAGNOSTICS_STYLE_PROPERTIES.');
      if (seen.has(property)) invalid(`Duplicate CSS property "${property}".`);
      seen.add(property);
    }
    const pseudo = options?.pseudo;
    if (pseudo !== undefined && (typeof pseudo !== 'string' || !PSEUDOS.has(pseudo))) invalid('Unsupported diagnostic pseudo-element.');
    const element = resolve(target);
    const style = win.getComputedStyle(element, pseudo ?? null);
    const result: ComputedStylesResult = {
      element: summary(element), pseudo: pseudo ?? null, properties: {},
      complete: true, truncatedProperties: [], redactedProperties: [],
    };
    for (const property of properties) {
      const value = sanitize(style.getPropertyValue(property), L.maxStyleValueLength);
      result.properties[property] = value.value;
      if (value.truncated) result.truncatedProperties.push(property);
      if (value.redacted) result.redactedProperties.push(property);
    }
    result.complete = !result.truncatedProperties.length;
    return result;
  }

  function styleContext(target: Target | undefined): StyleContextResult {
    const element = resolve(target);
    const result: StyleContextResult = {
      element: summary(element), classes: [], inline: [], matchedRules: [], stylesheets: [],
      cascade: 'not-resolved', scope: 'accessible-current-document-stylesheets', complete: true,
      omissions: {
        classes: 0, stylesheets: 0, inaccessibleStylesheets: 0, rules: false, matchedRules: false,
        declarations: false, unsupportedDeclarations: 0, unsupportedRules: 0, selectorErrors: 0,
        truncatedStrings: 0, shadowRootStyles: element.getRootNode() instanceof ShadowRoot,
      },
      notes: [
        'Rules are accessible selectors matched in active supported conditions. They are not cascade winners.',
        'Only diagnostic CSS properties are returned. Custom properties and unsupported declarations are excluded.',
        '@import, nested selectors, container/scope rules, and other unsupported rules are reported as omissions.',
      ],
    };
    const omit = result.omissions;
    let declarationsVisited = 0;
    let rulesVisited = 0;
    let sheetsVisited = 0;
    const inspected = new Set<CSSStyleSheet>();

    function text(value: string, max: number = L.maxStyleValueLength): Sanitized {
      const cleaned = sanitize(value, max);
      if (cleaned.truncated) omit.truncatedStrings++;
      return cleaned;
    }

    for (let i = 0; i < Math.min(element.classList.length, L.maxClasses); i++) {
      result.classes.push(text(element.classList.item(i) ?? '', 128).value);
    }
    omit.classes = Math.max(0, element.classList.length - L.maxClasses);

    function declarations(style: CSSStyleDeclaration): StyleDeclaration[] {
      const values: StyleDeclaration[] = [];
      for (let i = 0; i < style.length; i++) {
        if (declarationsVisited >= L.maxDeclarations) {
          omit.declarations = true;
          break;
        }
        declarationsVisited++;
        const property = style.item(i);
        if (!PROPERTIES.has(property)) {
          omit.unsupportedDeclarations++;
          continue;
        }
        const value = text(style.getPropertyValue(property));
        values.push({ property, value: value.value, priority: style.getPropertyPriority(property) === 'important' ? 'important' : '', redacted: value.redacted });
      }
      return values;
    }

    if (element instanceof HTMLElement || element instanceof SVGElement) result.inline = declarations(element.style);

    function mediaMatches(condition: string): boolean | null {
      if (!condition || condition === 'all') return true;
      if (condition.length > L.maxStyleValueLength) {
        omit.truncatedStrings++;
        return null;
      }
      try { return win.matchMedia(condition).matches; } catch { return null; }
    }

    function inspectSheet(sheet: CSSStyleSheet, kind: StyleSheetInfo['kind']): CSSRuleList | null {
      if (sheetsVisited >= L.maxStylesheets) {
        omit.stylesheets++;
        return null;
      }
      sheetsVisited++;
      if (inspected.has(sheet)) return null;
      inspected.add(sheet);
      let origin: string | null = null;
      if (sheet.href) {
        try { origin = new URL(sheet.href.slice(0, 4096), doc.baseURI).origin; } catch { origin = null; }
      }
      const info: StyleSheetInfo = { index: result.stylesheets.length, kind, origin, status: 'accessible' };
      result.stylesheets.push(info);
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        info.status = 'inaccessible';
        omit.inaccessibleStylesheets++;
        return null;
      }
      const active = mediaMatches(sheet.media.mediaText);
      if (sheet.disabled || active === false) {
        info.status = 'inactive';
        return null;
      }
      if (active === null || kind === 'import') {
        info.status = 'omitted';
        omit.unsupportedRules++;
        return null;
      }
      return rules;
    }

    function walkRules(rules: CSSRuleList, sheetIndex: number): void {
      const stack: Array<{ rules: CSSRuleList; index: number; path: number[]; conditions: string[] }> = [
        { rules, index: 0, path: [], conditions: [] },
      ];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.index >= frame.rules.length) {
          stack.pop();
          continue;
        }
        if (rulesVisited >= L.maxRules) {
          omit.rules = true;
          return;
        }
        const index = frame.index++;
        const rule = frame.rules[index];
        const path = [...frame.path, index];
        rulesVisited++;
        if (rule instanceof CSSStyleRule) {
          if (rule.cssRules?.length) omit.unsupportedRules++;
          if (rule.selectorText.length > 4096 || /(^|[\s,(])&/.test(rule.selectorText)) {
            omit.unsupportedRules++;
            continue;
          }
          let matches = false;
          try { matches = element.matches(rule.selectorText); } catch { omit.selectorErrors++; }
          if (!matches) continue;
          if (result.matchedRules.length >= L.maxMatchedRules) {
            omit.matchedRules = true;
            continue;
          }
          const selector = text(rule.selectorText.replace(/\[([^\s~|^$*=\]]+)[^\]]*\]/g, '[$1]'), 512);
          result.matchedRules.push({
            sheetIndex, rulePath: path, selector: selector.value,
            selectorRedacted: selector.redacted || selector.value !== rule.selectorText,
            conditions: [...frame.conditions], declarations: declarations(rule.style),
          });
        } else if (rule instanceof CSSImportRule) {
          omit.unsupportedRules++;
          if (rule.styleSheet) inspectSheet(rule.styleSheet, 'import');
        } else if (rule instanceof CSSGroupingRule) {
          let active: boolean | null = null;
          let condition = '';
          if (rule instanceof CSSMediaRule) {
            condition = rule.conditionText;
            active = mediaMatches(condition);
          } else if (rule instanceof CSSSupportsRule) {
            condition = rule.conditionText;
            if (condition.length <= L.maxStyleValueLength) {
              try { active = CSS.supports(condition); } catch { active = null; }
            }
          } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
            active = true;
            condition = `@layer ${rule.name}`;
          }
          if (active === false) continue;
          if (active === null || stack.length >= L.maxCssRuleDepth) {
            omit.unsupportedRules++;
            continue;
          }
          stack.push({ rules: rule.cssRules, index: 0, path, conditions: [...frame.conditions, text(condition).value] });
        } else {
          omit.unsupportedRules++;
        }
      }
    }

    const collections: Array<{ sheets: StyleSheetList | CSSStyleSheet[]; kind: 'document' | 'adopted' }> = [
      { sheets: doc.styleSheets, kind: 'document' },
      { sheets: doc.adoptedStyleSheets ?? [], kind: 'adopted' },
    ];
    for (const { sheets, kind } of collections) {
      for (let i = 0; i < sheets.length; i++) {
        if (sheetsVisited >= L.maxStylesheets) {
          omit.stylesheets += sheets.length - i;
          break;
        }
        const sheet = sheets[i];
        const sheetIndex = result.stylesheets.length;
        const rules = inspectSheet(sheet, kind);
        if (rules && !omit.shadowRootStyles) walkRules(rules, sheetIndex);
      }
    }
    if (omit.shadowRootStyles) result.notes.push('Document styles do not cross this shadow boundary. Shadow-root styles were not inspected.');
    result.complete = !(
      omit.classes || omit.stylesheets || omit.inaccessibleStylesheets || omit.rules || omit.matchedRules ||
      omit.declarations || omit.unsupportedRules || omit.selectorErrors || omit.truncatedStrings || omit.shadowRootStyles
    );
    return result;
  }

  function boxModel(target: Target | undefined): BoxModelResult {
    const element = resolve(target);
    const style = win.getComputedStyle(element);
    const value = (property: string): string => style.getPropertyValue(property);
    const edges = (prefix: string, suffix = ''): BoxEdges => ({
      top: px(value(`${prefix}-top${suffix}`)), right: px(value(`${prefix}-right${suffix}`)),
      bottom: px(value(`${prefix}-bottom${suffix}`)), left: px(value(`${prefix}-left${suffix}`)),
    });
    const margin = edges('margin');
    const padding = edges('padding');
    const border = edges('border', '-width');
    const bounds = rect(element.getBoundingClientRect());
    const rawRects = element.getClientRects();
    const clientRects: RectMeasurement[] = [];
    for (let i = 0; i < Math.min(rawRects.length, L.maxClientRects); i++) clientRects.push(rect(rawRects[i]));
    const display = value('display');
    const boxSizing = value('box-sizing');
    const svg = element instanceof SVGElement;
    const visible = helpers.isVisible(element);
    const rendered = clientRects.some((item) => item.width > 0 && item.height > 0);
    const measuredViewport = viewport();
    const usable = rendered && !svg && display !== 'contents' && (boxSizing === 'content-box' || boxSizing === 'border-box');
    const cssWidth = usable ? px(value('width')) : null;
    const cssHeight = usable ? px(value('height')) : null;
    const content: BoxSize = boxSizing === 'border-box' ? {
      width: subtract(cssWidth, padding.left, padding.right, border.left, border.right),
      height: subtract(cssHeight, padding.top, padding.bottom, border.top, border.bottom),
    } : { width: cssWidth, height: cssHeight };
    const paddingSize: BoxSize = {
      width: sum(content.width, padding.left, padding.right), height: sum(content.height, padding.top, padding.bottom),
    };
    const borderSize: BoxSize = {
      width: sum(paddingSize.width, border.left, border.right), height: sum(paddingSize.height, border.top, border.bottom),
    };
    const marginSize: BoxSize = {
      width: sum(borderSize.width, margin.left, margin.right), height: sum(borderSize.height, margin.top, margin.bottom),
    };
    const transforms: BoxModelResult['transforms'] = [];
    let ancestor: Element | null = element;
    let depth = 0;
    while (ancestor && depth < L.maxAncestorDepth) {
      const css = ancestor === element ? style : win.getComputedStyle(ancestor);
      const transform = css.getPropertyValue('transform') || 'none';
      const translate = css.getPropertyValue('translate') || 'none';
      const rotate = css.getPropertyValue('rotate') || 'none';
      const scale = css.getPropertyValue('scale') || 'none';
      const zoom = css.getPropertyValue('zoom') || '1';
      if ([transform, translate, rotate, scale].some((item) => item !== 'none') || !['1', 'normal', '100%'].includes(zoom)) {
        transforms.push({ ref: ref(ancestor), transform: sanitize(transform, 1024).value, translate: sanitize(translate, 1024).value,
          rotate: sanitize(rotate, 1024).value, scale: sanitize(scale, 1024).value, zoom: sanitize(zoom, 1024).value });
      }
      ancestor = parentAcrossShadow(ancestor);
      depth++;
    }
    const notes = [
      'Rects are post-transform axis-aligned viewport CSS pixels. Scroll offsets are separate; do not multiply by devicePixelRatio.',
      'CSS boxes use untransformed computed pixel dimensions. HTML offset/client metrics are rounded layout measurements.',
      'Margin sizes are arithmetic sums. Margin collapse and auto-margin distribution are not inferred.',
    ];
    if (!visible) notes.push('Element is not visible. Its geometry does not prove actionability.');
    if (!rendered || display === 'contents') notes.push('Element has no measured principal box; CSS box dimensions are unresolved.');
    if (svg) notes.push('SVG has no HTML offset/client box metrics. Its CSS box dimensions are not treated as SVG geometry.');
    if (clientRects.length > 1) notes.push('Fragmented layout has multiple client rects; a bounding rect is not a single CSS box.');
    if (transforms.length) notes.push('Transforms or zoom affect viewport bounds; they are not applied to the reported CSS edge widths.');
    if (ancestor) notes.push('Ancestor transform scan reached its depth limit.');
    return {
      element: summary(element), coordinateSpace: 'viewport-css-pixels', viewport: measuredViewport,
      boundingRect: bounds, clientRects, clientRectsTruncated: rawRects.length > L.maxClientRects,
      visible, rendered, inViewport: bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 &&
        bounds.left < measuredViewport.width && bounds.top < measuredViewport.height,
      svg, display, boxSizing, margin, border, padding, cssBoxes: { content, padding: paddingSize, border: borderSize, margin: marginSize },
      layoutMetrics: element instanceof HTMLElement ? {
        offsetWidth: finite(element.offsetWidth, 'offsetWidth'), offsetHeight: finite(element.offsetHeight, 'offsetHeight'),
        clientWidth: finite(element.clientWidth, 'clientWidth'), clientHeight: finite(element.clientHeight, 'clientHeight'),
        scrollWidth: finite(element.scrollWidth, 'scrollWidth'), scrollHeight: finite(element.scrollHeight, 'scrollHeight'),
      } : null,
      transformed: transforms.length > 0, transforms, ancestorScanTruncated: ancestor !== null, notes,
    };
  }

  function hitTest(point: HitTestPoint): HitTestResult {
    object(point, 'hitTest point', ['x', 'y']);
    for (const axis of ['x', 'y'] as const) {
      if (typeof point[axis] !== 'number' || !Number.isFinite(point[axis]) || Math.abs(point[axis]) > L.maxCoordinate) {
        invalid(`${axis} must be a finite viewport CSS-pixel coordinate within +/-${L.maxCoordinate}.`);
      }
    }
    ensureDocument();
    const measuredViewport = viewport();
    const inViewport = point.x >= 0 && point.y >= 0 && point.x < measuredViewport.width && point.y < measuredViewport.height;
    const result: HitTestResult = {
      point: { x: point.x, y: point.y }, coordinateSpace: 'viewport-css-pixels', viewport: measuredViewport,
      inViewport, top: null, stack: [], complete: true, truncated: false,
      notes: ['Read-only native hit test. Underlying non-ancestors may be obstructed by the top hit; no intended target is inferred.'],
    };
    if (!inViewport) {
      result.notes.push('Point is outside this viewport; no hit test was performed.');
      return result;
    }
    if (typeof doc.elementsFromPoint !== 'function') throw new DiagnosticsError('unavailable', 'Native elementsFromPoint is unavailable.');
    const hits = doc.elementsFromPoint(point.x, point.y);
    const top = hits[0];
    if (!top) return result;
    result.top = summary(attached(top));
    for (let i = 0; i < Math.min(hits.length, L.maxHitElements); i++) {
      const element = attached(hits[i]);
      const style = win.getComputedStyle(element);
      const relationship = i === 0 ? 'top' : element.contains(top) ? 'ancestor-of-top' : 'underlying';
      result.stack.push({
        element: summary(element), relationship, obstructedBy: relationship === 'underlying' ? result.top.ref : null,
        pointerEvents: sanitize(style.getPropertyValue('pointer-events'), 128).value,
        opacity: numeric(style.getPropertyValue('opacity')), position: sanitize(style.getPropertyValue('position'), 128).value,
        zIndex: sanitize(style.getPropertyValue('z-index'), 128).value,
        frameBoundary: ['iframe', 'frame'].includes(element.localName), shadowBoundary: element.shadowRoot !== null,
      });
    }
    result.truncated = hits.length > L.maxHitElements;
    result.complete = !result.truncated;
    result.notes.push('Native hits exclude pointer-events:none elements and can retarget shadow content to its host.');
    if (result.stack.some((item) => item.frameBoundary || item.shadowBoundary)) {
      result.notes.push('Iframe documents and shadow-root interiors were not read. Route diagnostics to a frame separately.');
    }
    return result;
  }

  function remove(baseline: StoredBaseline): void {
    if (baselines.delete(baseline.id)) totalBytes -= baseline.capture.info.bytes;
  }

  function tick(): number {
    return finite(win.performance.now(), 'monotonic clock');
  }

  function pruneExpired(): void {
    const now = tick();
    for (const baseline of baselines.values()) if (now >= baseline.expiresTick) remove(baseline);
  }

  function lookup(owner: string, id: string, requireRoot: boolean): StoredBaseline {
    ownerName(owner);
    baselineId(id);
    const baseline = baselines.get(id);
    if (!baseline) throw new DiagnosticsError('unknown_baseline', 'Unknown, expired, or released DOM baseline.');
    if (baseline.owner !== owner) throw new DiagnosticsError('wrong_owner', 'DOM baseline belongs to a different session owner.');
    if (tick() >= baseline.expiresTick) {
      remove(baseline);
      throw new DiagnosticsError('expired_baseline', 'DOM baseline expired after its five-minute TTL.');
    }
    if (requireRoot) {
      const root = baseline.root.deref();
      if (!root) throw new DiagnosticsError('detached_root', 'The original DOM baseline root no longer exists.');
      attached(root);
    }
    return baseline;
  }

  function capture(root: Element, maxNodes: number, maxText: number): Capture {
    const nodes: BaselineNode[] = [];
    const info: BaselineCaptureInfo = {
      nodeCount: 0, visitedNodes: 0, textChars: 0, bytes: 512, complete: true, truncated: false,
      omissions: { nodeLimit: false, textLimit: false, byteLimit: false, visitLimit: false, depthLimit: false,
        excludedSubtrees: 0, formControls: 0, iframeDocuments: 0, shadowRoots: 0 },
    };
    const omitted = info.omissions;
    const nodeBytes = (node: BaselineNode): number => encoder.encode(JSON.stringify(node)).byteLength + 192;
    type Frame = { cursor: Node | null; parent: BaselineNode | null; index: number; depth: number; rootOnly?: boolean };
    const stack: Frame[] = [{ cursor: root, parent: null, index: 0, depth: 0, rootOnly: true }];

    function boundedText(raw: string): Sanitized {
      const cleaned = sanitize(raw, Math.min(L.maxTextPerNode, Math.max(0, maxText - info.textChars)));
      if (cleaned.truncated) omitted.textLimit = true;
      return cleaned;
    }

    function hidden(element: Element, style: CSSStyleDeclaration): boolean {
      return EXCLUDED_TAGS.has(element.localName) || element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true' ||
        element.localName === 'input' && element.getAttribute('type')?.toLowerCase() === 'hidden' ||
        style.getPropertyValue('display') === 'none' || ['hidden', 'collapse'].includes(style.getPropertyValue('visibility')) ||
        style.getPropertyValue('content-visibility') === 'hidden' || numeric(style.getPropertyValue('opacity')) === 0;
    }

    let ancestor = parentAcrossShadow(root);
    let ancestorDepth = 0;
    while (ancestor && ancestorDepth < L.maxAncestorDepth) {
      if (hidden(ancestor, win.getComputedStyle(ancestor))) {
        omitted.excludedSubtrees++;
        stack.length = 0;
        break;
      }
      ancestor = parentAcrossShadow(ancestor);
      ancestorDepth++;
    }
    if (ancestor && ancestorDepth >= L.maxAncestorDepth) {
      omitted.depthLimit = true;
      stack.length = 0;
    }

    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame.cursor) {
        stack.pop();
        continue;
      }
      if (info.visitedNodes >= L.maxVisitedNodes) {
        omitted.visitLimit = true;
        break;
      }
      const current = frame.cursor;
      frame.cursor = frame.rootOnly ? null : current.nextSibling;
      info.visitedNodes++;
      if (current.nodeType === Node.TEXT_NODE) {
        const parent = frame.parent;
        if (!parent || parent.formValueRedacted || !parent.visible) continue;
        const separator = parent.text ? ' ' : '';
        const remaining = Math.max(0, maxText - info.textChars - separator.length);
        const text = sanitize(current.nodeValue ?? '', Math.min(L.maxTextPerNode, remaining));
        if (text.truncated) omitted.textLimit = true;
        const combined = sanitize(`${parent.text}${separator}${text.value}`,
          Math.min(L.maxTextPerNode, parent.text.length + Math.max(0, maxText - info.textChars)));
        if (combined.truncated) omitted.textLimit = true;
        const previousBytes = nodeBytes(parent);
        const candidate: BaselineNode = { ...parent, text: combined.value, textComplete: parent.textComplete && !text.truncated && !combined.truncated };
        const delta = nodeBytes(candidate) - previousBytes;
        if (info.bytes + delta > L.maxBaselineBytes) {
          omitted.byteLimit = true;
          if (parent.textComplete && info.bytes + 1 <= L.maxBaselineBytes) {
            parent.textComplete = false;
            info.bytes++;
          }
          break;
        }
        info.textChars += candidate.text.length - parent.text.length;
        parent.text = candidate.text;
        parent.textComplete = candidate.textComplete;
        info.bytes += delta;
        continue;
      }
      if (!(current instanceof Element)) continue;
      if (EXCLUDED_TAGS.has(current.localName)) {
        omitted.excludedSubtrees++;
        continue;
      }
      const style = win.getComputedStyle(current);
      if (hidden(current, style)) {
        omitted.excludedSubtrees++;
        continue;
      }
      if (nodes.length >= maxNodes) {
        omitted.nodeLimit = true;
        break;
      }
      const visible = style.getPropertyValue('display') === 'contents' || helpers.isVisible(current);
      const form = FORM_TAGS.has(current.localName);
      const editable = current instanceof HTMLElement && current.isContentEditable;
      const rawRole = current.getAttribute('role');
      const role = rawRole && /^[a-z][a-z0-9-]{0,63}$/.test(rawRole) ? rawRole : null;
      const rawType = current.localName === 'input' ? (current.getAttribute('type') ?? 'text').toLowerCase() : null;
      const inputType = rawType !== null && INPUT_TYPES.has(rawType) ? rawType : rawType === null ? null : 'text';
      const label = visible && !form && !editable ? boundedText(
        current.getAttribute('aria-label') ?? current.getAttribute('alt') ?? current.getAttribute('title') ?? '',
      ) : { value: '', truncated: false, redacted: false };
      const aria = (name: string): boolean | null => {
        const value = current.getAttribute(name);
        return value === 'true' ? true : value === 'false' ? false : null;
      };
      const node: BaselineNode = {
        ref: ref(current), parentRef: frame.parent?.ref ?? null, index: frame.index++, tag: current.localName.slice(0, 64),
        namespace: current.namespaceURI === 'http://www.w3.org/1999/xhtml' ? 'html' :
          current.namespaceURI === 'http://www.w3.org/2000/svg' ? 'svg' : 'other',
        role, label: label.value, text: '', textComplete: !label.truncated,
        visible, enabled: !current.matches(':disabled') && current.getAttribute('aria-disabled') !== 'true',
        editable: editable || form && !current.hasAttribute('readonly') && !current.matches(':disabled'),
        checked: current instanceof HTMLInputElement && ['checkbox', 'radio'].includes(inputType ?? '') ? current.checked : aria('aria-checked'),
        expanded: aria('aria-expanded'), selected: aria('aria-selected'), pressed: aria('aria-pressed'),
        inputType, formValueRedacted: form || editable,
      };
      const bytes = nodeBytes(node);
      if (info.bytes + bytes > L.maxBaselineBytes) {
        omitted.byteLimit = true;
        break;
      }
      info.textChars += label.value.length;
      info.bytes += bytes;
      nodes.push(node);
      if (form || editable) {
        omitted.formControls++;
        continue;
      }
      if (['iframe', 'frame'].includes(current.localName)) {
        omitted.iframeDocuments++;
        continue;
      }
      if (current.shadowRoot) omitted.shadowRoots++;
      if (current.firstChild) {
        if (frame.depth >= L.maxDomDepth) omitted.depthLimit = true;
        else stack.push({ cursor: current.firstChild, parent: node, index: 0, depth: frame.depth + 1 });
      }
    }
    info.nodeCount = nodes.length;
    info.truncated = omitted.nodeLimit || omitted.textLimit || omitted.byteLimit || omitted.visitLimit || omitted.depthLimit;
    info.complete = !info.truncated;
    return { nodes, info };
  }

  function descriptor(baseline: StoredBaseline): BaselineDescriptor {
    return {
      id: baseline.id, rootRef: baseline.rootRef, createdAt: baseline.createdAt, expiresAt: baseline.expiresAt,
      ttlMs: L.baselineTtlMs, scope: 'visible-semantic-light-dom',
      limits: { maxNodes: baseline.maxNodes, maxText: baseline.maxText, maxBytes: L.maxBaselineBytes,
        maxDepth: L.maxDomDepth, maxVisitedNodes: L.maxVisitedNodes },
      capture: copyInfo(baseline.capture.info), notes: [...BASELINE_NOTES],
    };
  }

  function baselineCreate(owner: string, options?: BaselineCreateOptions): BaselineDescriptor {
    ownerName(owner);
    if (options !== undefined) object(options, 'baselineCreate options', ['target', 'maxNodes', 'maxText']);
    const maxNodes = integer(options?.maxNodes, L.defaultMaxNodes, 1, L.maxNodes, 'maxNodes');
    const maxText = integer(options?.maxText, L.defaultMaxText, 0, L.maxText, 'maxText');
    const root = resolve(options?.target);
    pruneExpired();
    let ownerCount = 0;
    let ownerBytes = 0;
    for (const baseline of baselines.values()) {
      if (baseline.owner === owner) {
        ownerCount++;
        ownerBytes += baseline.capture.info.bytes;
      }
    }
    if (ownerCount >= L.maxBaselinesPerOwner || baselines.size >= L.maxBaselines) {
      throw new DiagnosticsError('capacity_exceeded', 'DOM baseline count capacity reached. Release baselines first.');
    }
    const captured = capture(root, maxNodes, maxText);
    if (ownerBytes + captured.info.bytes > L.maxOwnerBytes || totalBytes + captured.info.bytes > L.maxTotalBytes) {
      throw new DiagnosticsError('capacity_exceeded', 'DOM baseline byte capacity reached. Release baselines first.');
    }
    if (!win.crypto || typeof win.crypto.getRandomValues !== 'function') {
      throw new DiagnosticsError('unavailable', 'Cryptographic randomness is required for DOM baseline IDs.');
    }
    let id = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const random = new Uint8Array(16);
      try {
        win.crypto.getRandomValues(random);
      } catch {
        throw new DiagnosticsError('unavailable', 'Cryptographic DOM baseline ID generation failed.');
      }
      id = `db_${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      if (!baselines.has(id)) break;
      id = '';
    }
    if (!id) throw new DiagnosticsError('unavailable', 'Could not allocate a unique cryptographic DOM baseline ID.');
    const createdAt = Date.now();
    const baseline: StoredBaseline = {
      id, owner, root: new WeakRef(root), rootRef: ref(root), createdAt, expiresAt: createdAt + L.baselineTtlMs,
      expiresTick: tick() + L.baselineTtlMs, maxNodes, maxText, capture: captured,
    };
    baselines.set(id, baseline);
    totalBytes += captured.info.bytes;
    return descriptor(baseline);
  }

  function baselineCompare(owner: string, id: string, options?: BaselineCompareOptions): BaselineComparison {
    if (options !== undefined) object(options, 'baselineCompare options', ['maxChanges']);
    const maxChanges = integer(options?.maxChanges, L.defaultMaxChanges, 1, L.maxChanges, 'maxChanges');
    ensureDocument();
    const baseline = lookup(owner, id, true);
    const root = baseline.root.deref();
    if (!root) throw new DiagnosticsError('detached_root', 'The original DOM baseline root no longer exists.');
    const after = capture(attached(root), baseline.maxNodes, baseline.maxText);
    const before = baseline.capture;
    const oldNodes = new Map(before.nodes.map((node) => [node.ref, node]));
    const newNodes = new Map(after.nodes.map((node) => [node.ref, node]));
    const changes: BaselineChange[] = [];
    const totals = { added: 0, removed: 0, changed: 0, total: 0 };
    const add = (change: BaselineChange): void => {
      totals[change.kind]++;
      totals.total++;
      if (changes.length < maxChanges) changes.push(change);
    };
    for (const node of after.nodes) {
      const previous = oldNodes.get(node.ref);
      if (!previous) add({ kind: 'added', certainty: before.info.complete ? 'confirmed' : 'unverified', after: { ...node } });
      else {
        const fields = (Object.keys(node) as Array<keyof BaselineNode>).filter((key) =>
          key !== 'ref' && key !== 'textComplete' && previous[key] !== node[key]);
        if (fields.length) {
          const uncertainText = fields.some((key) => key === 'label' || key === 'text') && (!previous.textComplete || !node.textComplete);
          add({ kind: 'changed', certainty: uncertainText ? 'unverified' : 'confirmed', fields, before: { ...previous }, after: { ...node } });
        }
      }
    }
    for (const node of before.nodes) {
      if (!newNodes.has(node.ref)) add({ kind: 'removed', certainty: after.info.complete ? 'confirmed' : 'unverified', before: { ...node } });
    }
    const capturesComplete = before.info.complete && after.info.complete;
    const truncated = !capturesComplete || totals.total > maxChanges;
    return {
      id, rootRef: baseline.rootRef, scope: 'visible-semantic-light-dom', before: copyInfo(before.info), after: copyInfo(after.info),
      changes, totals, totalsExact: capturesComplete, complete: !truncated, truncated,
      unchanged: totals.total ? false : capturesComplete ? true : null,
    };
  }

  function baselineDescribe(owner: string, id: string): BaselineDescriptor {
    ensureDocument();
    return descriptor(lookup(owner, id, true));
  }

  function baselineRelease(owner: string, id: string): BaselineReleaseResult {
    if (disposed) throw new DiagnosticsError('disposed', 'Diagnostics API has been disposed.');
    remove(lookup(owner, id, false));
    return { id, released: true };
  }

  function releaseOwner(owner: string): ReleaseOwnerResult {
    ownerName(owner);
    let released = 0;
    for (const baseline of baselines.values()) {
      if (baseline.owner === owner) {
        remove(baseline);
        released++;
      }
    }
    return { released };
  }

  function dispose(): DiagnosticsDisposeResult {
    const released = baselines.size;
    baselines.clear();
    totalBytes = 0;
    disposed = true;
    return { released, disposed: true };
  }

  return { computedStyles, styleContext, boxModel, hitTest, baselineCreate, baselineCompare, baselineDescribe, baselineRelease, releaseOwner, dispose };
}
