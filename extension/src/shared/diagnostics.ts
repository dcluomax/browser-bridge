import type { ElementSummary, Locator } from './locators.ts';

export interface Target {
  ref?: string;
  locator?: Locator;
}

export interface DiagnosticsHelpers {
  resolveTarget(target: Target | undefined): Element;
  refFor(element: Element): string;
  summarize(element: Element): ElementSummary;
  isVisible(element: Element): boolean;
}

export const DIAGNOSTICS_LIMITS = Object.freeze({
  maxStyleProperties: 64,
  maxStyleValueLength: 1024,
  maxClasses: 64,
  maxStylesheets: 32,
  maxRules: 512,
  maxMatchedRules: 64,
  maxDeclarations: 256,
  maxCssRuleDepth: 8,
  maxClientRects: 16,
  maxHitElements: 16,
  maxAncestorDepth: 128,
  maxCoordinate: 1_000_000,
  defaultMaxNodes: 500,
  maxNodes: 2000,
  defaultMaxText: 8192,
  maxText: 65_536,
  maxTextPerNode: 256,
  maxVisitedNodes: 20_000,
  maxDomDepth: 128,
  defaultMaxChanges: 100,
  maxChanges: 500,
  baselineTtlMs: 300_000,
  maxBaselinesPerOwner: 8,
  maxBaselines: 32,
  maxBaselineBytes: 262_144,
  maxOwnerBytes: 524_288,
  maxTotalBytes: 2_097_152,
});

export const DIAGNOSTICS_STYLE_PROPERTIES: readonly string[] = Object.freeze([
  'display', 'visibility', 'opacity', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'box-sizing',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-radius',
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-decoration-line', 'text-overflow',
  'white-space', 'word-break', 'overflow-wrap', 'vertical-align', 'direction', 'writing-mode',
  'overflow', 'overflow-x', 'overflow-y', 'overflow-anchor', 'overscroll-behavior',
  'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'flex-direction', 'flex-wrap',
  'align-items', 'align-content', 'align-self', 'justify-content', 'justify-items', 'justify-self', 'order',
  'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-auto-flow',
  'grid-auto-columns', 'grid-auto-rows', 'grid-column', 'grid-row',
  'transform', 'transform-origin', 'transform-style', 'translate', 'rotate', 'scale', 'zoom',
  'pointer-events', 'cursor', 'user-select', 'touch-action', 'object-fit', 'object-position',
  'clip-path', 'filter', 'contain', 'content-visibility', 'isolation', 'mix-blend-mode',
]);

export interface ComputedStylesOptions {
  properties?: string[];
  pseudo?: string;
}

export interface ComputedStylesResult {
  element: ElementSummary;
  pseudo: string | null;
  properties: Record<string, string>;
  complete: boolean;
  truncatedProperties: string[];
  redactedProperties: string[];
}

export interface StyleDeclaration {
  property: string;
  value: string;
  priority: '' | 'important';
  redacted: boolean;
}

export interface StyleSheetInfo {
  index: number;
  kind: 'document' | 'adopted' | 'import';
  origin: string | null;
  status: 'accessible' | 'inaccessible' | 'inactive' | 'omitted';
}

export interface MatchedStyleRule {
  sheetIndex: number;
  rulePath: number[];
  selector: string;
  selectorRedacted: boolean;
  conditions: string[];
  declarations: StyleDeclaration[];
}

export interface StyleContextResult {
  element: ElementSummary;
  classes: string[];
  inline: StyleDeclaration[];
  matchedRules: MatchedStyleRule[];
  stylesheets: StyleSheetInfo[];
  cascade: 'not-resolved';
  scope: 'accessible-current-document-stylesheets';
  complete: boolean;
  omissions: {
    classes: number;
    stylesheets: number;
    inaccessibleStylesheets: number;
    rules: boolean;
    matchedRules: boolean;
    declarations: boolean;
    unsupportedDeclarations: number;
    unsupportedRules: number;
    selectorErrors: number;
    truncatedStrings: number;
    shadowRootStyles: boolean;
  };
  notes: string[];
}

export interface RectMeasurement {
  x: number;
  y: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface ViewportMeasurement {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  visualViewport: {
    offsetLeft: number;
    offsetTop: number;
    pageLeft: number;
    pageTop: number;
    width: number;
    height: number;
    scale: number;
  } | null;
}

export interface BoxEdges {
  top: number | null;
  right: number | null;
  bottom: number | null;
  left: number | null;
}

export interface BoxSize {
  width: number | null;
  height: number | null;
}

export interface BoxModelResult {
  element: ElementSummary;
  coordinateSpace: 'viewport-css-pixels';
  viewport: ViewportMeasurement;
  boundingRect: RectMeasurement;
  clientRects: RectMeasurement[];
  clientRectsTruncated: boolean;
  visible: boolean;
  rendered: boolean;
  inViewport: boolean;
  svg: boolean;
  display: string;
  boxSizing: string;
  margin: BoxEdges;
  border: BoxEdges;
  padding: BoxEdges;
  cssBoxes: { content: BoxSize; padding: BoxSize; border: BoxSize; margin: BoxSize };
  layoutMetrics: {
    offsetWidth: number;
    offsetHeight: number;
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
  } | null;
  transformed: boolean;
  transforms: Array<{ ref: string; transform: string; translate: string; rotate: string; scale: string; zoom: string }>;
  ancestorScanTruncated: boolean;
  notes: string[];
}

export interface HitTestPoint {
  x: number;
  y: number;
}

export interface HitTestEntry {
  element: ElementSummary;
  relationship: 'top' | 'ancestor-of-top' | 'underlying';
  obstructedBy: string | null;
  pointerEvents: string;
  opacity: number | null;
  position: string;
  zIndex: string;
  frameBoundary: boolean;
  shadowBoundary: boolean;
}

export interface HitTestResult {
  point: HitTestPoint;
  coordinateSpace: 'viewport-css-pixels';
  viewport: ViewportMeasurement;
  inViewport: boolean;
  top: ElementSummary | null;
  stack: HitTestEntry[];
  complete: boolean;
  truncated: boolean;
  notes: string[];
}

export interface BaselineCreateOptions {
  target?: Target;
  maxNodes?: number;
  /** Total label and direct-text characters, not a per-element budget. */
  maxText?: number;
}

export interface BaselineCompareOptions {
  maxChanges?: number;
}

export interface BaselineNode {
  ref: string;
  parentRef: string | null;
  index: number;
  tag: string;
  namespace: 'html' | 'svg' | 'other';
  /** Explicit DOM role only; this is not an accessibility-tree snapshot. */
  role: string | null;
  label: string;
  /** Visible direct text only; descendant text belongs to descendant records. */
  text: string;
  textComplete: boolean;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  checked: boolean | null;
  expanded: boolean | null;
  selected: boolean | null;
  pressed: boolean | null;
  inputType: string | null;
  formValueRedacted: boolean;
}

export interface BaselineCaptureInfo {
  nodeCount: number;
  visitedNodes: number;
  textChars: number;
  /** Retained UTF-8 JSON bytes plus a fixed per-record accounting allowance. */
  bytes: number;
  complete: boolean;
  truncated: boolean;
  omissions: {
    nodeLimit: boolean;
    textLimit: boolean;
    byteLimit: boolean;
    visitLimit: boolean;
    depthLimit: boolean;
    excludedSubtrees: number;
    formControls: number;
    iframeDocuments: number;
    shadowRoots: number;
  };
}

export interface BaselineDescriptor {
  id: string;
  rootRef: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  scope: 'visible-semantic-light-dom';
  limits: { maxNodes: number; maxText: number; maxBytes: number; maxDepth: number; maxVisitedNodes: number };
  capture: BaselineCaptureInfo;
  notes: string[];
}

export type BaselineChange =
  | { kind: 'added'; certainty: 'confirmed' | 'unverified'; after: BaselineNode }
  | { kind: 'removed'; certainty: 'confirmed' | 'unverified'; before: BaselineNode }
  | { kind: 'changed'; certainty: 'confirmed' | 'unverified'; fields: Array<keyof BaselineNode>; before: BaselineNode; after: BaselineNode };

export interface BaselineComparison {
  id: string;
  rootRef: string;
  scope: 'visible-semantic-light-dom';
  before: BaselineCaptureInfo;
  after: BaselineCaptureInfo;
  changes: BaselineChange[];
  totals: { added: number; removed: number; changed: number; total: number };
  totalsExact: boolean;
  complete: boolean;
  truncated: boolean;
  /** Null means incomplete captures cannot verify absence of change. */
  unchanged: boolean | null;
}

export interface BaselineReleaseResult {
  id: string;
  released: true;
}

export interface ReleaseOwnerResult {
  released: number;
}

export interface DiagnosticsDisposeResult {
  released: number;
  disposed: true;
}

export type DiagnosticsErrorCode =
  | 'invalid_argument' | 'disposed' | 'document_replaced' | 'detached_root'
  | 'unknown_baseline' | 'wrong_owner' | 'expired_baseline' | 'capacity_exceeded' | 'unavailable';

export interface DiagnosticsApi {
  computedStyles(target: Target | undefined, options?: ComputedStylesOptions): ComputedStylesResult;
  styleContext(target: Target | undefined): StyleContextResult;
  boxModel(target: Target | undefined): BoxModelResult;
  hitTest(point: HitTestPoint): HitTestResult;
  baselineCreate(owner: string, options?: BaselineCreateOptions): BaselineDescriptor;
  baselineCompare(owner: string, id: string, options?: BaselineCompareOptions): BaselineComparison;
  baselineDescribe(owner: string, id: string): BaselineDescriptor;
  baselineRelease(owner: string, id: string): BaselineReleaseResult;
  releaseOwner(owner: string): ReleaseOwnerResult;
  dispose(): DiagnosticsDisposeResult;
}
