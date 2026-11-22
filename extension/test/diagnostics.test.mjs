import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/content/diagnostics.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
});
const { createDiagnosticsApi, DiagnosticsError, DIAGNOSTICS_LIMITS: limits } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const originalDateNow = Date.now;

class MockNode {
  static TEXT_NODE = 3;
  constructor(nodeType, ownerDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this._nextSibling = null;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { return this._nextSibling; }
  get parentElement() { return this.parentNode instanceof MockElement ? this.parentNode : null; }
  get isConnected() {
    const root = this.getRootNode();
    return root instanceof MockDocument || root instanceof MockShadowRoot && root.host.isConnected;
  }
  getRootNode() {
    let current = this;
    while (current.parentNode) current = current.parentNode;
    return current;
  }
  appendChild(child) {
    child.remove();
    const previous = this.childNodes.at(-1);
    if (previous) previous._nextSibling = child;
    this.childNodes.push(child);
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    child._nextSibling = null;
    return child;
  }
  insertBefore(child, before) {
    child.remove();
    const index = this.childNodes.indexOf(before);
    assert.ok(index >= 0);
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.forEach((node, i) => { node._nextSibling = this.childNodes[i + 1] ?? null; });
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const children = this.parentNode.childNodes;
    const index = children.indexOf(this);
    if (index > 0) children[index - 1]._nextSibling = this._nextSibling;
    children.splice(index, 1);
    this.parentNode = null;
    this._nextSibling = null;
  }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
}

class MockText extends MockNode {
  constructor(value, document) { super(3, document); this.value = value; }
  get nodeValue() {
    if (this.forbidden) throw new Error('Forbidden hidden/form text was read');
    return this.value;
  }
  get textContent() { return this.nodeValue; }
}

class MockDeclaration {
  constructor(values = {}, priorities = {}) {
    this.values = values;
    this.priorities = priorities;
  }
  get length() { return Object.keys(this.values).length; }
  item(index) { return Object.keys(this.values)[index] ?? ''; }
  getPropertyValue(name) { return this.values[name] ?? ''; }
  getPropertyPriority(name) { return this.priorities[name] ?? ''; }
}

function rectangle(x = 10, y = 20, width = 100, height = 40) {
  return { x, y, top: y, left: x, right: x + width, bottom: y + height, width, height };
}

class MockElement extends MockNode {
  constructor(tag, document, namespace = 'http://www.w3.org/1999/xhtml') {
    super(1, document);
    this.localName = tag;
    this.namespaceURI = namespace;
    this.attributes = new Map();
    this.style = new MockDeclaration();
    this.computed = {};
    this.shadowRoot = null;
    this.rect = rectangle();
    this.rects = null;
  }
  get classList() {
    const tokens = (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    return { length: tokens.length, item: (index) => tokens[index] ?? null };
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  matches(selector) {
    if (selector === ':disabled') return this.hasAttribute('disabled');
    if (selector === '[') throw new DOMException('Invalid selector', 'SyntaxError');
    return selector.split(',').some((part) => {
      const value = part.trim();
      if (value.startsWith('.')) return (this.getAttribute('class') ?? '').split(/\s+/).includes(value.slice(1));
      if (value.startsWith('#')) return this.getAttribute('id') === value.slice(1);
      return value === this.localName || value === '*';
    });
  }
  getBoundingClientRect() { return this.computed.display === 'none' ? rectangle(0, 0, 0, 0) : this.rect; }
  getClientRects() { return this.computed.display === 'none' ? [] : this.rects ?? [this.rect]; }
  dispatchEvent() { throw new Error('Diagnostics must not dispatch events'); }
  focus() { throw new Error('Diagnostics must not focus'); }
  scrollIntoView() { throw new Error('Diagnostics must not scroll'); }
  get outerHTML() { throw new Error('Diagnostics must not serialize HTML'); }
}

class MockHTMLElement extends MockElement {
  constructor(tag, document) {
    super(tag, document);
    this.offsetWidth = 100;
    this.offsetHeight = 40;
    this.clientWidth = 100;
    this.clientHeight = 40;
    this.scrollWidth = 100;
    this.scrollHeight = 40;
  }
  get isContentEditable() {
    const attr = this.getAttribute('contenteditable');
    if (attr === 'false') return false;
    return attr === '' || attr === 'true' || (this.parentElement?.isContentEditable ?? false);
  }
}

class MockInput extends MockHTMLElement {
  constructor(document) { super('input', document); this.checked = false; }
  get value() { throw new Error('Input values must never be read'); }
}

class MockSVGElement extends MockElement {
  constructor(tag, document) { super(tag, document, 'http://www.w3.org/2000/svg'); }
}

class MockShadowRoot extends MockNode {
  constructor(host) { super(11, host.ownerDocument); this.host = host; }
  get isConnected() { return this.host.isConnected; }
}

class MockDocument extends MockNode {
  constructor() {
    super(9, null);
    this.ownerDocument = this;
    this.documentElement = this.appendChild(new MockHTMLElement('html', this));
    this.body = this.documentElement.appendChild(new MockHTMLElement('body', this));
    this.styleSheets = [];
    this.adoptedStyleSheets = [];
    this.baseURI = 'https://example.test/private?token=do-not-read';
    this.hits = [];
    this.hitCalls = [];
  }
  elementsFromPoint(x, y) { this.hitCalls.push({ x, y }); return this.hits; }
  createElement(tag) { return tag === 'input' ? new MockInput(this) : new MockHTMLElement(tag, this); }
}

class MockStyleRule {
  constructor(selector, values, priorities) {
    this.selectorText = selector;
    this.style = new MockDeclaration(values, priorities);
    this.cssRules = [];
  }
}
class MockGroupingRule {
  constructor(rules) { this.cssRules = rules; }
}
class MockMediaRule extends MockGroupingRule {
  constructor(condition, rules) { super(rules); this.conditionText = condition; }
}
class MockSupportsRule extends MockGroupingRule {
  constructor(condition, rules) { super(rules); this.conditionText = condition; }
}
class MockLayerRule extends MockGroupingRule {
  constructor(name, rules) { super(rules); this.name = name; }
}
class MockImportRule {
  constructor(styleSheet) { this.styleSheet = styleSheet; }
}

function stylesheet(rules, options = {}) {
  return {
    href: options.href ?? null, disabled: options.disabled ?? false, media: { mediaText: options.media ?? '' },
    get cssRules() {
      if (options.inaccessible) throw new DOMException('Cannot access stylesheet', 'SecurityError');
      return rules;
    },
  };
}

const DEFAULT_STYLE = {
  display: 'block', visibility: 'visible', opacity: '1', position: 'static', 'z-index': 'auto',
  width: '100px', height: '40px', 'box-sizing': 'content-box', color: 'rgb(1, 2, 3)',
  'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px',
  'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
  'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px',
  'pointer-events': 'auto', transform: 'none', translate: 'none', rotate: 'none', scale: 'none', zoom: '1',
};

function environment(t) {
  const document = new MockDocument();
  const env = {
    document, time: 100, wall: 1_700_000_000_000, styles: [], summarizeCalls: 0, resolverCalls: 0,
  };
  const window = {
    document, innerWidth: 800, innerHeight: 600, scrollX: 12, scrollY: 34, devicePixelRatio: 2,
    visualViewport: null, crypto: webcrypto, performance: { now: () => env.time },
    getComputedStyle(element, pseudo = null) {
      env.styles.push({ element, pseudo });
      return new MockDeclaration({ ...DEFAULT_STYLE, ...element.computed, ...(element.pseudos?.[pseudo] ?? {}) });
    },
    matchMedia: (condition) => ({ matches: condition !== 'not all' && condition !== '(min-width: 2000px)' }),
  };
  Object.assign(globalThis, {
    document, window, Node: MockNode, Element: MockElement, HTMLElement: MockHTMLElement,
    HTMLInputElement: MockInput, SVGElement: MockSVGElement, ShadowRoot: MockShadowRoot,
    CSSStyleRule: MockStyleRule, CSSGroupingRule: MockGroupingRule, CSSMediaRule: MockMediaRule,
    CSSSupportsRule: MockSupportsRule, CSSLayerBlockRule: MockLayerRule, CSSImportRule: MockImportRule,
    CSS: { supports: (condition) => condition === '(display: grid)' },
  });
  Date.now = () => env.wall;
  const elementToRef = new WeakMap();
  const refs = new Map();
  let nextRef = 1;
  const helpers = {
    refFor(element) {
      if (!elementToRef.has(element)) {
        const ref = `e${nextRef++}`;
        elementToRef.set(element, ref);
        refs.set(ref, element);
      }
      return elementToRef.get(element);
    },
    resolveTarget(target) {
      env.resolverCalls++;
      if (!target) return document.body;
      if (target.ref) {
        const found = refs.get(target.ref);
        if (!found) throw new Error('Unknown ref');
        return found;
      }
      throw new Error('Locator resolution is delegated to the parent helper');
    },
    isVisible(element) {
      const style = { ...DEFAULT_STYLE, ...element.computed };
      return style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) &&
        element.getClientRects().some((item) => item.width > 0 && item.height > 0);
    },
    summarize(element) {
      env.summarizeCalls++;
      if (env.forbidSummary) throw new Error('Baseline must not use aggregated helper text');
      return {
        ref: helpers.refFor(element), tag: element.localName, role: element.getAttribute('role'),
        name: element.summaryName ?? '', text: element.summaryText ?? '',
        visible: helpers.isVisible(element), enabled: !element.hasAttribute('disabled'),
        editable: false, checked: null,
      };
    },
  };
  env.window = window;
  env.helpers = helpers;
  env.api = createDiagnosticsApi(helpers);
  env.target = (element) => ({ ref: helpers.refFor(element) });
  env.add = (tag = 'div', parent = document.body) => parent.appendChild(document.createElement(tag));
  env.text = (parent, value, forbidden = false) => {
    const node = new MockText(value, document);
    node.forbidden = forbidden;
    return parent.appendChild(node);
  };
  t.after(() => { env.api.dispose(); Date.now = originalDateNow; });
  return env;
}

function errorCode(action, code) {
  assert.throws(action, (error) => error instanceof DiagnosticsError && error.code === code);
}

test('computed styles measure selected properties and the requested supported pseudo', (t) => {
  const env = environment(t);
  const target = env.add();
  target.computed = { width: '123.5px', display: 'grid' };
  target.pseudos = { '::before': { color: 'rgb(9, 8, 7)' } };
  const measured = env.api.computedStyles(env.target(target), { properties: ['width', 'display'] });
  assert.deepEqual(measured.properties, { width: '123.5px', display: 'grid' });
  assert.equal(measured.pseudo, null);
  assert.equal(measured.element.ref, env.helpers.refFor(target));
  assert.equal(measured.complete, true);
  const pseudo = env.api.computedStyles(env.target(target), { properties: ['color'], pseudo: '::before' });
  assert.equal(pseudo.properties.color, 'rgb(9, 8, 7)');
  assert.equal(env.styles.at(-1).pseudo, '::before');
  assert.ok(Object.keys(env.api.computedStyles(undefined).properties).length <= limits.maxStyleProperties);
});

test('computed styles reject invalid values instead of silently choosing defaults', (t) => {
  const { api } = environment(t);
  for (const options of [
    null, [], { properties: null }, { properties: [] }, { properties: ['--secret'] },
    { properties: ['color', 'color'] }, { properties: ['COLOR'] }, { properties: [3] },
    { properties: Array(65).fill('color') }, { pseudo: ':before' }, { pseudo: '' }, { pseudo: null },
    { pseudo: '::made-up' }, { surprise: true },
  ]) errorCode(() => api.computedStyles(undefined, options), 'invalid_argument');
  for (const target of [null, {}, [], 'e1', { ref: '' }, { ref: 'e1', locator: {} }, { locator: null }, { ref: 'e1', extra: 1 }]) {
    errorCode(() => api.boxModel(target), 'invalid_argument');
  }
});

test('validation errors stay bounded even when invalid property names are very large', (t) => {
  const { api } = environment(t);
  for (const options of [{ properties: ['x'.repeat(100_000)] }, { ['x'.repeat(100_000)]: true }]) {
    assert.throws(() => api.computedStyles(undefined, options), (error) =>
      error instanceof DiagnosticsError && error.code === 'invalid_argument' && error.message.length < 256);
  }
});

test('computed values and helper summaries redact URLs, tokens and form content', (t) => {
  const env = environment(t);
  const element = env.add();
  element.summaryText = 'token=private-value https://user:pass@example.test/?key=secret';
  element.computed = { cursor: 'url(https://user:pass@example.test/?key=secret), auto', 'font-family': 'word '.repeat(400) };
  const result = env.api.computedStyles(env.target(element), { properties: ['cursor', 'font-family'] });
  assert.deepEqual(result.redactedProperties, ['cursor']);
  assert.deepEqual(result.truncatedProperties, ['font-family']);
  assert.equal(result.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /private-value|user:pass|key=secret/);
  const input = env.add('input');
  input.summaryName = 'password=do-not-expose';
  input.summaryText = '123456';
  const inputResult = env.api.computedStyles(env.target(input), { properties: ['display'] });
  assert.equal(inputResult.element.name, '');
  assert.equal(inputResult.element.text, '');
});

test('style context matches real accessible selectors and active supported conditions, never winners', (t) => {
  const env = environment(t);
  const element = env.add();
  element.setAttribute('class', 'target active');
  element.style = new MockDeclaration({ color: 'blue', '--secret': 'private-value' }, { color: 'important' });
  env.document.styleSheets.push(stylesheet([
    new MockStyleRule('.missing', { color: 'red' }),
    new MockStyleRule('.target', { color: 'green' }),
    new MockMediaRule('not all', [new MockStyleRule('.target', { width: '999px' })]),
    new MockMediaRule('screen', [new MockStyleRule('.active', { width: '123px' })]),
    new MockSupportsRule('(display: grid)', [new MockStyleRule('.target', { display: 'grid' })]),
    new MockSupportsRule('(display: alien)', [new MockStyleRule('.target', { display: 'none' })]),
    new MockLayerRule('base', [new MockStyleRule('.target', { height: '42px' })]),
  ], { href: 'https://user:password@example.test/main.css?token=secret' }));
  env.document.styleSheets.push(stylesheet([], { inaccessible: true, href: 'https://other.test/private.css?token=secret' }));
  env.document.adoptedStyleSheets.push(stylesheet([new MockStyleRule('.target', { opacity: '0.5' })]));
  const result = env.api.styleContext(env.target(element));
  assert.deepEqual(result.classes, ['target', 'active']);
  assert.deepEqual(result.inline, [{ property: 'color', value: 'blue', priority: 'important', redacted: false }]);
  assert.equal(result.matchedRules.length, 5);
  assert.equal(result.matchedRules[1].declarations[0].value, '123px');
  assert.deepEqual(result.matchedRules[1].conditions, ['screen']);
  assert.deepEqual(result.matchedRules[2].conditions, ['(display: grid)']);
  assert.equal(result.matchedRules.at(-1).sheetIndex, 2);
  assert.equal(result.cascade, 'not-resolved');
  assert.equal(result.stylesheets[1].status, 'inaccessible');
  assert.equal(result.omissions.inaccessibleStylesheets, 1);
  assert.equal(result.omissions.unsupportedDeclarations, 1);
  assert.equal(result.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /private-value|user:password|token=secret/);
  assert.ok(result.matchedRules.every((rule) => !('winner' in rule)));
});

test('CSSOM omissions include inaccessible imports, unsupported groups, nesting and selector failures', (t) => {
  const env = environment(t);
  const element = env.add();
  element.setAttribute('class', 'target');
  const nested = new MockStyleRule('.missing', {});
  nested.cssRules.push(new MockStyleRule('& .target', { color: 'red' }));
  env.document.styleSheets.push(stylesheet([
    nested, new MockStyleRule('[', { color: 'red' }),
    new MockGroupingRule([new MockStyleRule('.target', { color: 'red' })]),
    new MockImportRule(stylesheet([], { inaccessible: true, href: 'https://other.test/import.css' })),
  ]));
  const result = env.api.styleContext(env.target(element));
  assert.equal(result.matchedRules.length, 0);
  assert.equal(result.omissions.inaccessibleStylesheets, 1);
  assert.equal(result.omissions.selectorErrors, 1);
  assert.ok(result.omissions.unsupportedRules >= 3);
  assert.equal(result.complete, false);
});

test('style context is bounded by classes, sheets, rules, matches and declaration budgets', (t) => {
  const env = environment(t);
  const element = env.add();
  element.setAttribute('class', Array.from({ length: 70 }, (_, i) => `c${i}`).join(' '));
  env.document.styleSheets = Array.from({ length: 40 }, () => stylesheet([
    ...Array.from({ length: 600 }, () => new MockStyleRule('div', { color: 'red', width: '5px' })),
  ]));
  const result = env.api.styleContext(env.target(element));
  assert.equal(result.classes.length, limits.maxClasses);
  assert.equal(result.omissions.classes, 6);
  assert.equal(result.stylesheets.length, limits.maxStylesheets);
  assert.equal(result.omissions.stylesheets, 8);
  assert.equal(result.matchedRules.length, limits.maxMatchedRules);
  assert.equal(result.omissions.rules, true);
  assert.equal(result.omissions.matchedRules, true);
  assert.equal(result.complete, false);

  element.style = new MockDeclaration(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`--p${i}`, 'secret'])));
  const declarationResult = env.api.styleContext(env.target(element));
  assert.equal(declarationResult.inline.length, 0);
  assert.equal(declarationResult.omissions.declarations, true);
});

test('document stylesheet selectors are not presented as applied inside a shadow root', (t) => {
  const env = environment(t);
  const host = env.add();
  const shadow = new MockShadowRoot(host);
  host.shadowRoot = shadow;
  const element = shadow.appendChild(env.document.createElement('div'));
  env.document.styleSheets.push(stylesheet([new MockStyleRule('div', { color: 'red' })]));
  const result = env.api.styleContext(env.target(element));
  assert.equal(result.matchedRules.length, 0);
  assert.equal(result.omissions.shadowRootStyles, true);
  assert.equal(result.complete, false);
});

test('duplicate adopted sheets cannot bypass the total sheet-entry work budget', (t) => {
  const env = environment(t);
  const element = env.add();
  const duplicate = stylesheet([new MockStyleRule('div', { color: 'red' })]);
  let entriesRead = 0;
  env.document.adoptedStyleSheets = new Proxy(Array(1000).fill(duplicate), {
    get(array, property, receiver) {
      if (/^\d+$/.test(String(property))) entriesRead++;
      return Reflect.get(array, property, receiver);
    },
  });
  const result = env.api.styleContext(env.target(element));
  assert.equal(entriesRead, limits.maxStylesheets);
  assert.equal(result.stylesheets.length, 1);
  assert.equal(result.matchedRules.length, 1);
  assert.equal(result.omissions.stylesheets, 1000 - limits.maxStylesheets);
  assert.equal(result.complete, false);
});

test('box model measures CSS edges separately from transformed viewport bounds and integer layout metrics', (t) => {
  const env = environment(t);
  const parent = env.add();
  parent.computed.transform = 'translateX(3px)';
  const element = env.add('div', parent);
  element.computed = {
    width: '100px', height: '40px', 'padding-left': '10px', 'padding-right': '10px',
    'padding-top': '5px', 'padding-bottom': '5px', 'border-left-width': '2px', 'border-right-width': '2px',
    'border-top-width': '1px', 'border-bottom-width': '1px', 'margin-left': '3px', 'margin-right': '3px',
    'margin-top': '4px', 'margin-bottom': '4px', transform: 'matrix(2, 0, 0, 2, 0, 0)',
  };
  element.rect = rectangle(100, 120, 248, 104);
  element.offsetWidth = 124;
  element.offsetHeight = 52;
  element.clientWidth = 120;
  element.clientHeight = 50;
  const result = env.api.boxModel(env.target(element));
  assert.equal(result.coordinateSpace, 'viewport-css-pixels');
  assert.deepEqual(result.boundingRect, rectangle(100, 120, 248, 104));
  assert.deepEqual(result.cssBoxes.content, { width: 100, height: 40 });
  assert.deepEqual(result.cssBoxes.padding, { width: 120, height: 50 });
  assert.deepEqual(result.cssBoxes.border, { width: 124, height: 52 });
  assert.deepEqual(result.cssBoxes.margin, { width: 130, height: 60 });
  assert.equal(result.layoutMetrics.offsetWidth, 124);
  assert.equal(result.transformed, true);
  assert.equal(result.transforms.length, 2);
  assert.equal(result.viewport.devicePixelRatio, 2);
  assert.equal(result.viewport.scrollX, 12);
  assert.equal(result.inViewport, true);
});

test('border-box, auto margins, invisible boxes, SVG and fragments remain explicit', (t) => {
  const env = environment(t);
  const element = env.add();
  element.computed = {
    'box-sizing': 'border-box', width: '100px', height: '40px',
    'padding-left': '10px', 'padding-right': '10px', 'border-left-width': '2px', 'border-right-width': '2px',
    'margin-left': 'auto',
  };
  element.rects = Array.from({ length: 20 }, (_, i) => rectangle(10, i * 5, 30, 5));
  const result = env.api.boxModel(env.target(element));
  assert.deepEqual(result.cssBoxes.content, { width: 76, height: 40 });
  assert.equal(result.margin.left, null);
  assert.equal(result.cssBoxes.margin.width, null);
  assert.equal(result.clientRects.length, limits.maxClientRects);
  assert.equal(result.clientRectsTruncated, true);
  element.computed.display = 'none';
  const invisible = env.api.boxModel(env.target(element));
  assert.equal(invisible.visible, false);
  assert.equal(invisible.rendered, false);
  assert.equal(invisible.inViewport, false);
  assert.equal(invisible.cssBoxes.border.width, null);
  const svg = env.document.body.appendChild(new MockSVGElement('svg', env.document));
  const svgResult = env.api.boxModel(env.target(svg));
  assert.equal(svgResult.svg, true);
  assert.equal(svgResult.layoutMetrics, null);
  assert.deepEqual(svgResult.cssBoxes.content, { width: null, height: null });
  assert.match(svgResult.notes.join(' '), /SVG/);
});

test('layout reports unresolved CSS lengths and visual viewport measurements without inventing zeros', (t) => {
  const env = environment(t);
  const element = env.add();
  element.computed.width = 'auto';
  element.computed['padding-left'] = 'calc(2% + 1px)';
  env.window.visualViewport = { width: 400, height: 300, offsetLeft: 5, offsetTop: 8, pageLeft: 17, pageTop: 42, scale: 2 };
  const result = env.api.boxModel(env.target(element));
  assert.equal(result.cssBoxes.content.width, null);
  assert.equal(result.padding.left, null);
  assert.equal(result.viewport.visualViewport.scale, 2);
  element.rect.x = Number.NaN;
  errorCode(() => env.api.boxModel(env.target(element)), 'unavailable');
});

test('native hit tests report underlying obstructions, not ancestor obstructions, without inputs', (t) => {
  const env = environment(t);
  const target = env.add('button');
  const overlay = env.add();
  overlay.computed = { position: 'fixed', 'z-index': '10', opacity: '0' };
  env.document.hits = [overlay, target, env.document.body, env.document.documentElement];
  const result = env.api.hitTest({ x: 20, y: 30 });
  assert.equal(result.top.ref, env.helpers.refFor(overlay));
  assert.equal(result.stack[1].relationship, 'underlying');
  assert.equal(result.stack[1].obstructedBy, result.top.ref);
  assert.equal(result.stack[2].relationship, 'ancestor-of-top');
  assert.equal(result.stack[2].obstructedBy, null);
  assert.equal(result.stack[0].opacity, 0);
  assert.deepEqual(env.document.hitCalls, [{ x: 20, y: 30 }]);
  assert.equal(result.complete, true);
});

test('hit-test bounds, unavailable native APIs, truncation and iframe boundaries are explicit', (t) => {
  const env = environment(t);
  const frame = env.add('iframe');
  Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('Iframe interiors must not be read'); } });
  env.document.hits = [frame, ...Array.from({ length: 20 }, () => env.add())];
  const result = env.api.hitTest({ x: 0, y: 0 });
  assert.equal(result.stack.length, limits.maxHitElements);
  assert.equal(result.stack[0].frameBoundary, true);
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.match(result.notes.join(' '), /Iframe/);
  const outside = env.api.hitTest({ x: -1, y: 600 });
  assert.equal(outside.inViewport, false);
  assert.equal(outside.top, null);
  assert.equal(env.document.hitCalls.length, 1);
  for (const point of [null, {}, { x: 1 }, { x: '1', y: 2 }, { x: NaN, y: 2 }, { x: Infinity, y: 2 },
    { x: limits.maxCoordinate + 1, y: 2 }, { x: 1, y: 2, target: 'e1' }]) {
    errorCode(() => env.api.hitTest(point), 'invalid_argument');
  }
  env.document.elementsFromPoint = undefined;
  errorCode(() => env.api.hitTest({ x: 1, y: 2 }), 'unavailable');
});

test('baseline create/describe shapes use opaque IDs, copied metadata and no owner or HTML', (t) => {
  const env = environment(t);
  env.text(env.add('p'), 'Visible evidence');
  const baseline = env.api.baselineCreate('session-a');
  assert.match(baseline.id, /^db_[0-9a-f]{32}$/);
  assert.equal(baseline.scope, 'visible-semantic-light-dom');
  assert.equal(baseline.ttlMs, 300_000);
  assert.equal(baseline.expiresAt - baseline.createdAt, baseline.ttlMs);
  assert.equal(baseline.capture.nodeCount, 2);
  assert.equal(baseline.capture.complete, true);
  assert.equal('owner' in baseline, false);
  assert.equal('nodes' in baseline, false);
  baseline.capture.omissions.nodeLimit = true;
  baseline.notes.push('caller mutation');
  const description = env.api.baselineDescribe('session-a', baseline.id);
  assert.equal(description.capture.omissions.nodeLimit, false);
  assert.equal(description.notes.includes('caller mutation'), false);
  assert.equal(env.api.baselineCompare('session-a', baseline.id).unchanged, true);
});

test('baseline changes preserve stable refs, parent/index evidence and immutable original capture', (t) => {
  const env = environment(t);
  const first = env.add('p');
  const text = env.text(first, 'before');
  const removed = env.add('button');
  const moved = env.add('span');
  const baseline = env.api.baselineCreate('session-a');
  text.value = 'after';
  first.setAttribute('aria-expanded', 'true');
  first.appendChild(moved);
  removed.remove();
  const added = env.add('aside');
  const result = env.api.baselineCompare('session-a', baseline.id);
  assert.deepEqual(result.totals, { added: 1, removed: 1, changed: 2, total: 4 });
  assert.equal(result.totalsExact, true);
  assert.equal(result.complete, true);
  assert.equal(result.unchanged, false);
  const textChange = result.changes.find((change) => change.kind === 'changed' && change.after.ref === env.helpers.refFor(first));
  assert.ok(textChange.fields.includes('text'));
  assert.ok(textChange.fields.includes('expanded'));
  const move = result.changes.find((change) => change.kind === 'changed' && change.after.ref === env.helpers.refFor(moved));
  assert.equal(move.after.parentRef, env.helpers.refFor(first));
  assert.ok(move.fields.includes('parentRef'));
  assert.equal(result.changes.find((change) => change.kind === 'added').after.ref, env.helpers.refFor(added));
  textChange.before.text = 'caller mutation';
  result.before.omissions.nodeLimit = true;
  const again = env.api.baselineCompare('session-a', baseline.id);
  assert.equal(again.changes.find((change) => change.kind === 'changed' && change.after.ref === env.helpers.refFor(first)).before.text, 'before');
  assert.equal(again.before.omissions.nodeLimit, false);
  assert.deepEqual(again.totals, result.totals);
});

test('maxChanges limits only returned changes while totals still cover the captured evidence', (t) => {
  const env = environment(t);
  const baseline = env.api.baselineCreate('session-a');
  env.add('p'); env.add('button'); env.add('aside');
  const result = env.api.baselineCompare('session-a', baseline.id, { maxChanges: 1 });
  assert.equal(result.changes.length, 1);
  assert.equal(result.totals.added, 3);
  assert.equal(result.totals.total, 3);
  assert.equal(result.totalsExact, true);
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.equal(result.unchanged, false);
});

test('partial captures cannot claim verified unchanged, even when omitted changes produce zero observations', (t) => {
  const env = environment(t);
  env.add('p');
  const omitted = env.add('span');
  const text = env.text(omitted, 'before');
  const baseline = env.api.baselineCreate('session-a', { maxNodes: 2 });
  assert.equal(baseline.capture.omissions.nodeLimit, true);
  text.value = 'changed outside the capture';
  const result = env.api.baselineCompare('session-a', baseline.id);
  assert.equal(result.totals.total, 0);
  assert.equal(result.before.complete, false);
  assert.equal(result.after.complete, false);
  assert.equal(result.complete, false);
  assert.equal(result.totalsExact, false);
  assert.equal(result.truncated, true);
  assert.equal(result.unchanged, null);
});

test('partial-diff absence is marked unverified instead of asserting removal or addition', (t) => {
  const env = environment(t);
  const first = env.add('p');
  env.add('button');
  env.add('aside');
  const baseline = env.api.baselineCreate('session-a', { maxNodes: 4 });
  assert.equal(baseline.capture.complete, true);
  env.document.body.insertBefore(env.document.createElement('section'), first);
  env.document.body.insertBefore(env.document.createElement('nav'), first);
  const result = env.api.baselineCompare('session-a', baseline.id);
  assert.equal(result.after.complete, false);
  assert.ok(result.changes.some((change) => change.kind === 'removed'));
  assert.ok(result.changes.filter((change) => change.kind === 'removed').every((change) => change.certainty === 'unverified'));
  const partial = env.api.baselineCreate('session-a', { maxNodes: 2 });
  env.document.body.insertBefore(env.document.createElement('header'), env.document.body.firstChild);
  const added = env.api.baselineCompare('session-a', partial.id).changes.filter((change) => change.kind === 'added');
  assert.ok(added.length > 0);
  assert.ok(added.every((change) => change.certainty === 'unverified'));
});

test('text-budget drift is not misreported as a confirmed text change', (t) => {
  const env = environment(t);
  const first = env.add('p');
  const firstText = env.text(first, 'short');
  const second = env.add('p');
  env.text(second, 'This prose does not change');
  const baseline = env.api.baselineCreate('owner', { maxText: 20 });
  firstText.value = 'A much longer first paragraph';
  const changes = env.api.baselineCompare('owner', baseline.id).changes;
  const secondChange = changes.find((change) => change.kind === 'changed' && change.after.ref === env.helpers.refFor(second));
  assert.ok(secondChange);
  assert.equal(secondChange.certainty, 'unverified');
});

test('text budgets are integer-validated, global, per-node bounded and explicitly incomplete', (t) => {
  const env = environment(t);
  const paragraph = env.add('p');
  paragraph.setAttribute('aria-label', 'Static label');
  env.text(paragraph, 'Visible prose');
  env.text(paragraph, 'More visible prose');
  for (const maxText of [0, 1, 12, 16, 24]) {
    const baseline = env.api.baselineCreate(`owner-${maxText}`, { maxText });
    assert.ok(baseline.capture.textChars <= maxText);
    assert.equal(baseline.capture.complete, false);
    assert.equal(env.api.baselineCompare(`owner-${maxText}`, baseline.id).unchanged, null);
  }
  const large = env.add('p');
  env.text(large, 'visible prose '.repeat(40));
  const clipped = env.api.baselineCreate('large-text', { maxText: 2000 });
  assert.equal(clipped.capture.omissions.textLimit, true);
  assert.equal(clipped.capture.complete, false);
  for (const options of [null, { maxNodes: 0 }, { maxNodes: 1.5 }, { maxNodes: '5' }, { maxNodes: 2001 },
    { maxText: -1 }, { maxText: null }, { maxText: Infinity }, { maxText: 65_537 }, { ttlMs: 1000 }]) {
    errorCode(() => env.api.baselineCreate('valid-owner', options), 'invalid_argument');
  }
  for (const options of [null, { maxChanges: 0 }, { maxChanges: 0.5 }, { maxChanges: '5' }, { maxChanges: 501 }, { other: 1 }]) {
    errorCode(() => env.api.baselineCompare('large-text', clipped.id, options), 'invalid_argument');
  }
});

test('depth and total visited-node budgets terminate otherwise unbounded traversal', (t) => {
  const env = environment(t);
  let parent = env.document.body;
  for (let i = 0; i < limits.maxDomDepth + 3; i++) parent = env.add('div', parent);
  const deep = env.api.baselineCreate('deep', { maxNodes: 2000 });
  assert.equal(deep.capture.omissions.depthLimit, true);
  assert.equal(deep.capture.complete, false);
  for (const child of [...env.document.body.childNodes]) child.remove();
  for (let i = 0; i < limits.maxVisitedNodes + 2; i++) env.document.body.appendChild(new MockNode(8, env.document));
  const wide = env.api.baselineCreate('wide');
  assert.equal(wide.capture.visitedNodes, limits.maxVisitedNodes);
  assert.equal(wide.capture.omissions.visitLimit, true);
  assert.equal(wide.capture.complete, false);
});

test('baselines never read hidden/script/style/form values, HTML, arbitrary attributes or iframe contents', (t) => {
  const env = environment(t);
  env.forbidSummary = true;
  const paragraph = env.add('p');
  paragraph.setAttribute('data-secret', 'arbitrary-private-attribute');
  paragraph.setAttribute('onclick', 'private-source-code');
  const text = env.text(paragraph,
    'Visit https://user:credential@example.test/?access_token=query-secret token=token-secret otp=123456 <input value="html-secret">. ' +
    'access_token=access-secret csrf_token=csrf-secret client_secret=client-private /auth%3Fcode%3Dencoded-secret data:text/html;base64,data-private');
  const password = env.add('input');
  password.setAttribute('type', 'password');
  password.setAttribute('value', 'password-secret');
  password.setAttribute('aria-label', 'password-secret');
  env.text(password, 'password-child-secret', true);
  const otp = env.add('input');
  otp.setAttribute('autocomplete', 'one-time-code');
  otp.setAttribute('value', '654321');
  const textarea = env.add('textarea');
  env.text(textarea, 'textarea-secret', true);
  const select = env.add('select');
  env.text(env.add('option', select), 'option-value-secret', true);
  const editor = env.add();
  editor.setAttribute('contenteditable', 'true');
  env.text(editor, 'editable-secret', true);
  for (const tag of ['script', 'style', 'template']) env.text(env.add(tag), `${tag}-secret`, true);
  const hidden = env.add();
  hidden.setAttribute('hidden', '');
  env.text(hidden, 'hidden-secret', true);
  const invisible = env.add();
  invisible.computed.opacity = '0';
  env.text(invisible, 'opacity-secret', true);
  const ariaHidden = env.add();
  ariaHidden.setAttribute('aria-hidden', 'true');
  env.text(ariaHidden, 'aria-hidden-secret', true);
  const hiddenInput = env.add('input');
  hiddenInput.setAttribute('type', 'hidden');
  hiddenInput.setAttribute('value', 'hidden-value-secret');
  const frame = env.add('iframe');
  Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('Cross-origin iframe must not be read'); } });
  env.text(frame, 'iframe-fallback-secret', true);
  const baseline = env.api.baselineCreate('secret-test');
  assert.ok(baseline.capture.omissions.excludedSubtrees >= 7);
  assert.ok(baseline.capture.omissions.formControls >= 5);
  assert.equal(baseline.capture.omissions.iframeDocuments, 1);
  text.value = 'New safe public evidence';
  password.setAttribute('disabled', '');
  otp.remove();
  const comparison = env.api.baselineCompare('secret-test', baseline.id);
  assert.equal(env.summarizeCalls, 0);
  assert.doesNotMatch(JSON.stringify({ baseline, comparison }),
    /credential|query-secret|token-secret|access-secret|csrf-secret|client-private|encoded-secret|data-private|123456|654321|html-secret|arbitrary-private|private-source|password-secret|textarea-secret|option-value|editable-secret|hidden-secret|opacity-secret|aria-hidden-secret|hidden-value|iframe-fallback/);
  const changedPassword = comparison.changes.find((change) => change.kind === 'changed' && change.after.ref === env.helpers.refFor(password));
  assert.ok(changedPassword);
  assert.equal(changedPassword.after.formValueRedacted, true);
  assert.equal(changedPassword.after.label, '');
  assert.equal(changedPassword.after.text, '');
  assert.equal(changedPassword.after.inputType, 'password');
});

test('policy exclusions and form-value-only changes cannot introduce private state into evidence', (t) => {
  const env = environment(t);
  const input = env.add('input');
  input.setAttribute('value', 'before-secret');
  const checkbox = env.add('input');
  checkbox.setAttribute('type', 'checkbox');
  const baseline = env.api.baselineCreate('owner');
  input.setAttribute('value', 'after-secret');
  input.setAttribute('name', 'session-token-secret');
  const noChange = env.api.baselineCompare('owner', baseline.id);
  assert.equal(noChange.unchanged, true);
  checkbox.checked = true;
  const changed = env.api.baselineCompare('owner', baseline.id);
  assert.equal(changed.totals.changed, 1);
  assert.deepEqual(changed.changes[0].fields, ['checked']);
  assert.doesNotMatch(JSON.stringify(changed), /before-secret|after-secret|session-token-secret/);
});

test('owner isolation, cryptographic IDs, release and cleanup have explicit typed results and errors', (t) => {
  const env = environment(t);
  const first = env.api.baselineCreate('owner-a');
  const second = env.api.baselineCreate('owner-b');
  assert.notEqual(first.id, second.id);
  for (const operation of ['baselineDescribe', 'baselineCompare', 'baselineRelease']) {
    errorCode(() => env.api[operation]('owner-b', first.id), 'wrong_owner');
  }
  assert.equal(env.api.baselineDescribe('owner-a', first.id).id, first.id);
  assert.deepEqual(env.api.baselineRelease('owner-a', first.id), { id: first.id, released: true });
  errorCode(() => env.api.baselineDescribe('owner-a', first.id), 'unknown_baseline');
  assert.deepEqual(env.api.releaseOwner('owner-a'), { released: 0 });
  assert.deepEqual(env.api.releaseOwner('owner-b'), { released: 1 });
  errorCode(() => env.api.baselineDescribe('owner-b', second.id), 'unknown_baseline');
  for (const owner of ['', ' ', null, 123, 'x'.repeat(129)]) {
    errorCode(() => env.api.baselineCreate(owner), 'invalid_argument');
    errorCode(() => env.api.releaseOwner(owner), 'invalid_argument');
  }
  errorCode(() => env.api.baselineDescribe('owner-a', 'invented'), 'invalid_argument');
  env.api.baselineCreate('owner-a');
  assert.deepEqual(env.api.dispose(), { released: 1, disposed: true });
  assert.deepEqual(env.api.dispose(), { released: 0, disposed: true });
  assert.deepEqual(env.api.releaseOwner('owner-a'), { released: 0 });
  errorCode(() => env.api.boxModel(undefined), 'disposed');
  errorCode(() => env.api.baselineCreate('owner-a'), 'disposed');
  errorCode(() => env.api.baselineDescribe('owner-a', first.id), 'disposed');
});

test('five-minute expiry uses a monotonic clock, rejects expired IDs and frees capacity', (t) => {
  const env = environment(t);
  const first = env.api.baselineCreate('owner');
  env.time += limits.baselineTtlMs - 1;
  env.wall -= 1_000_000;
  assert.equal(env.api.baselineDescribe('owner', first.id).id, first.id);
  env.time++;
  errorCode(() => env.api.baselineDescribe('owner', first.id), 'expired_baseline');
  for (let i = 0; i < limits.maxBaselinesPerOwner; i++) env.api.baselineCreate('owner');
  env.time += limits.baselineTtlMs;
  assert.doesNotThrow(() => env.api.baselineCreate('owner'));
});

test('per-owner and global count capacities reject new handles without silently evicting old ones', (t) => {
  const env = environment(t);
  const owned = Array.from({ length: limits.maxBaselinesPerOwner }, () => env.api.baselineCreate('owner'));
  errorCode(() => env.api.baselineCreate('owner'), 'capacity_exceeded');
  assert.equal(env.api.baselineDescribe('owner', owned[0].id).id, owned[0].id);
  for (let i = owned.length; i < limits.maxBaselines; i++) env.api.baselineCreate(`owner-${i}`);
  errorCode(() => env.api.baselineCreate('overflow'), 'capacity_exceeded');
  env.api.baselineRelease('owner', owned[0].id);
  assert.doesNotThrow(() => env.api.baselineCreate('overflow'));
});

test('per-baseline, owner and global byte budgets are finite, visible and recover after release', (t) => {
  const env = environment(t);
  for (let i = 0; i < 1500; i++) {
    const element = env.add('p');
    element.setAttribute('aria-label', 'Public semantic evidence '.repeat(10));
    env.text(element, 'Visible diagnostic prose '.repeat(10));
  }
  const options = { maxNodes: 2000, maxText: 65_536 };
  const first = env.api.baselineCreate('large-owner', options);
  assert.ok(first.capture.bytes <= limits.maxBaselineBytes);
  assert.equal(first.capture.omissions.byteLimit, true);
  assert.equal(first.capture.complete, false);
  const second = env.api.baselineCreate('large-owner', options);
  assert.ok(first.capture.bytes + second.capture.bytes <= limits.maxOwnerBytes);
  errorCode(() => env.api.baselineCreate('large-owner', options), 'capacity_exceeded');
  let retained = first.capture.bytes + second.capture.bytes;
  let created = 2;
  while (retained + first.capture.bytes <= limits.maxTotalBytes) {
    const next = env.api.baselineCreate(`large-owner-${created++}`, options);
    retained += next.capture.bytes;
  }
  assert.ok(retained <= limits.maxTotalBytes);
  assert.ok(created < limits.maxBaselines);
  errorCode(() => env.api.baselineCreate('byte-overflow', options), 'capacity_exceeded');
  env.api.baselineRelease('large-owner', first.id);
  assert.doesNotThrow(() => env.api.baselineCreate('byte-overflow', options));
});

test('detached original roots never heal through the shared resolver; cleanup remains possible', (t) => {
  const env = environment(t);
  const root = env.add();
  const baseline = env.api.baselineCreate('owner', { target: env.target(root) });
  const resolverCalls = env.resolverCalls;
  root.remove();
  errorCode(() => env.api.baselineCompare('owner', baseline.id), 'detached_root');
  errorCode(() => env.api.baselineDescribe('owner', baseline.id), 'detached_root');
  assert.equal(env.resolverCalls, resolverCalls);
  assert.deepEqual(env.api.baselineRelease('owner', baseline.id), { id: baseline.id, released: true });
  errorCode(() => env.api.boxModel(env.target(root)), 'detached_root');
});

test('document replacement and documentElement replacement invalidate original handles, including same-URL navigation', (t) => {
  const env = environment(t);
  const baseline = env.api.baselineCreate('owner');
  const replacement = new MockDocument();
  globalThis.document = replacement;
  errorCode(() => env.api.baselineCompare('owner', baseline.id), 'document_replaced');
  globalThis.document = env.document;
  errorCode(() => env.api.baselineDescribe('owner', baseline.id), 'document_replaced');
  assert.deepEqual(env.api.releaseOwner('owner'), { released: 0 });
  const fresh = createDiagnosticsApi(env.helpers);
  t.after(() => fresh.dispose());
  const freshBaseline = fresh.baselineCreate('owner');
  const oldRoot = env.document.documentElement;
  oldRoot.remove();
  env.document.documentElement = env.document.appendChild(env.document.createElement('html'));
  errorCode(() => fresh.baselineCompare('owner', freshBaseline.id), 'document_replaced');
});

test('new factories do not inherit handles, and early creation can bind the first documentElement without healing documents', (t) => {
  const env = environment(t);
  const baseline = env.api.baselineCreate('owner');
  const reinjected = createDiagnosticsApi(env.helpers);
  t.after(() => reinjected.dispose());
  errorCode(() => reinjected.baselineDescribe('owner', baseline.id), 'unknown_baseline');
  assert.equal(reinjected.baselineCreate('owner').capture.complete, true);
  const root = env.document.documentElement;
  env.document.documentElement = null;
  const early = createDiagnosticsApi(env.helpers);
  t.after(() => early.dispose());
  env.document.documentElement = root;
  assert.equal(early.baselineCreate('owner').capture.complete, true);
});

test('factory initialization starts no timers, observers, measurements, resolution or entropy requests', (t) => {
  const env = environment(t);
  const forbidden = () => { throw new Error('Diagnostics must remain idle during factory initialization'); };
  const originalTimeout = globalThis.setTimeout;
  const originalInterval = globalThis.setInterval;
  env.window.setTimeout = forbidden;
  env.window.setInterval = forbidden;
  env.window.requestAnimationFrame = forbidden;
  env.window.performance.now = forbidden;
  env.window.getComputedStyle = forbidden;
  env.window.crypto = { getRandomValues: forbidden };
  for (const method of ['resolveTarget', 'refFor', 'summarize', 'isVisible']) env.helpers[method] = forbidden;
  try {
    globalThis.setTimeout = forbidden;
    globalThis.setInterval = forbidden;
    const idle = createDiagnosticsApi(env.helpers);
    assert.deepEqual(idle.dispose(), { released: 0, disposed: true });
    assert.equal(env.styles.length, 0);
    assert.equal(env.resolverCalls, 0);
    assert.equal(env.summarizeCalls, 0);
  } finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.setInterval = originalInterval;
  }
});

test('ordinary HTTP contexts generate opaque handles with getRandomValues and no randomUUID', (t) => {
  const env = environment(t);
  env.document.baseURI = 'http://example.test/';
  env.window.isSecureContext = false;
  env.window.crypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  assert.equal('randomUUID' in env.window.crypto, false);
  const first = env.api.baselineCreate('http-owner');
  const second = env.api.baselineCreate('http-owner');
  assert.match(first.id, /^db_[0-9a-f]{32}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(env.api.baselineDescribe('http-owner', first.id).id, first.id);
});

test('cryptographic randomness is mandatory; deterministic collisions never overwrite an existing handle', (t) => {
  const env = environment(t);
  env.window.crypto = { getRandomValues(array) { return array.fill(1); } };
  const first = env.api.baselineCreate('owner');
  errorCode(() => env.api.baselineCreate('owner'), 'unavailable');
  assert.equal(env.api.baselineDescribe('owner', first.id).id, first.id);
  env.window.crypto = null;
  errorCode(() => env.api.baselineCreate('owner'), 'unavailable');
});

test('platform entropy failures remain typed errors without retaining a partially created baseline', (t) => {
  const env = environment(t);
  env.window.crypto = { getRandomValues() { throw new DOMException('Randomness unavailable', 'OperationError'); } };
  errorCode(() => env.api.baselineCreate('owner'), 'unavailable');
  assert.deepEqual(env.api.releaseOwner('owner'), { released: 0 });
});
