import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/content/patches.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { createPatchApi, PatchError, PATCH_LIMITS } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

class MockNode {
  constructor(nodeType, ownerDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get isConnected() {
    const root = this.getRootNode();
    return root.nodeType === 9 || (root.nodeType === 11 && root.host.isConnected);
  }
  getRootNode() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node;
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('Not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
}

class MockText extends MockNode {
  constructor(data, doc) {
    super(3, doc);
    this._data = data;
  }
  get data() { return this._data; }
  set data(value) {
    this._data = String(value);
    this.ownerDocument.writes.push({ element: this.parentNode, name: '#text', value: this._data });
  }
  get textContent() { return this.data; }
}

const COLORS = new Set(['red', 'blue', 'green', 'black', 'white', 'transparent', 'rebeccapurple', 'currentColor']);
const CSS_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'width', 'height', 'opacity', 'display',
  'position', 'transform', 'font-family', 'font-size', 'border', 'border-color',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
]);

class MockStyle {
  constructor(element) {
    this.element = element;
    this.declarations = new Map();
  }
  get length() { return this.declarations.size; }
  item(index) { return [...this.declarations.keys()][index] ?? ''; }
  getPropertyValue(name) {
    if (name === 'margin' || name === 'padding') {
      const parts = ['top', 'right', 'bottom', 'left'].map((side) => this.declarations.get(`${name}-${side}`));
      if (parts.some((part) => !part)) return '';
      return parts.every((part) => part.value === parts[0].value) ? parts[0].value : parts.map((part) => part.value).join(' ');
    }
    return this.declarations.get(name)?.value ?? '';
  }
  getPropertyPriority(name) {
    if (name === 'margin' || name === 'padding') {
      const parts = ['top', 'right', 'bottom', 'left'].map((side) => this.declarations.get(`${name}-${side}`));
      return parts.every((part) => part && part.priority === parts[0]?.priority) ? parts[0]?.priority ?? '' : '';
    }
    return this.declarations.get(name)?.priority ?? '';
  }
  store(name, value, priority) {
    if (name === 'margin' || name === 'padding') {
      const parts = value.split(/\s+/);
      const values = [parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? parts[1] ?? parts[0]];
      ['top', 'right', 'bottom', 'left'].forEach((side, index) => {
        this.declarations.set(`${name}-${side}`, { value: values[index], priority });
      });
    } else {
      this.declarations.set(name, { value, priority });
    }
  }
  load(raw) {
    this.declarations.clear();
    for (const part of raw.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const name = part.slice(0, colon).trim();
      let value = part.slice(colon + 1).trim();
      const priority = /\s*!important$/i.test(value) ? 'important' : '';
      value = value.replace(/\s*!important$/i, '').trim();
      if (name && value) this.store(name, value, priority);
    }
  }
  serialize() {
    return [...this.declarations].map(([name, { value, priority }]) => `${name}: ${value}${priority ? ' !important' : ''};`).join(' ');
  }
  setProperty(name, value, priority = '') {
    if (!CSS_PROPERTIES.has(name) || !value || value.includes('not-valid')) return;
    if ((name === 'color' || name === 'background-color') && !COLORS.has(value) && !/^#[0-9a-f]{3,8}$/i.test(value)) return;
    this.store(name, value.trim(), priority.toLowerCase());
    this.element.setAttribute('style', this.serialize());
  }
  removeProperty(name) {
    const old = this.getPropertyValue(name);
    if (name === 'margin' || name === 'padding') {
      for (const side of ['top', 'right', 'bottom', 'left']) this.declarations.delete(`${name}-${side}`);
    } else {
      this.declarations.delete(name);
    }
    if (old) this.element.setAttribute('style', this.serialize());
    return old;
  }
}

class MockElement extends MockNode {
  constructor(tag, doc) {
    super(1, doc);
    this.localName = tag.toLowerCase();
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this.assignedSlot = null;
    this.shadowRoot = null;
    this.attributes = new Map();
    this.style = new MockStyle(this);
    this.failures = [];
  }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  fail(name, phase = 'before', value) { this.failures.push({ name, phase, value }); }
  throwIfRequested(name, phase, value) {
    const index = this.failures.findIndex((failure) => failure.name === name && failure.phase === phase &&
      (failure.value === undefined || failure.value === value));
    if (index >= 0) {
      this.failures.splice(index, 1);
      throw new Error(`Injected ${phase} ${name} write failure`);
    }
  }
  setAttribute(name, value) {
    value = String(value);
    this.throwIfRequested(name, 'before', value);
    this.attributes.set(name, value);
    if (name === 'style') this.style.load(value);
    this.ownerDocument.writes.push({ element: this, name, value });
    this.throwIfRequested(name, 'after', value);
  }
  removeAttribute(name) {
    this.throwIfRequested(name, 'before', null);
    this.attributes.delete(name);
    if (name === 'style') this.style.load('');
    this.ownerDocument.writes.push({ element: this, name, value: null });
    this.throwIfRequested(name, 'after', null);
  }
  get textContent() { return this.childNodes.map((node) => node.textContent ?? '').join(''); }
  set textContent(value) {
    for (const node of [...this.childNodes]) this.removeChild(node);
    if (value) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
}

class MockDocument extends MockNode {
  constructor() {
    super(9, null);
    this.writes = [];
    this.documentElement = new MockElement('html', this);
    this.body = new MockElement('body', this);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag) { return new MockElement(tag, this); }
  createTextNode(value) { return new MockText(value, this); }
}

function fixture(t) {
  const original = {
    document: globalThis.document,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    now: Date.now,
    consoleError: console.error,
    crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto'),
  };
  const doc = new MockDocument();
  const refs = new Map();
  const elementRefs = new WeakMap();
  const resolveCalls = [];
  const logs = [];
  const timers = new Map();
  let nextTimer = 1;
  let now = 1_700_000_000_000;
  globalThis.document = doc;
  Date.now = () => now;
  globalThis.setTimeout = (callback, ms) => {
    const id = nextTimer++;
    timers.set(id, { callback, at: now + ms });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  console.error = (...args) => logs.push(args.join(' '));
  const helpers = {
    resolveTarget(target) {
      resolveCalls.push(target);
      const ref = target?.ref ?? target?.locator?.steps[0]?.value;
      const element = refs.get(ref);
      if (!element) throw new Error(`Unknown ref ${ref}`);
      return element;
    },
    refFor(element) {
      return elementRefs.get(element) ?? 'unregistered';
    },
    summarize(element) {
      return {
        ref: helpers.refFor(element), tag: element.localName, role: element.getAttribute('role'),
        name: element.textContent, text: element.textContent, visible: !element.hasAttribute('hidden'),
        enabled: true, editable: false, checked: null,
      };
    },
  };
  const api = createPatchApi(helpers);
  t.after(() => {
    api.dispose();
    assert.equal(timers.size, 0, 'teardown must release every timer');
    if (original.document === undefined) delete globalThis.document;
    else globalThis.document = original.document;
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    Date.now = original.now;
    console.error = original.consoleError;
    if (original.crypto) Object.defineProperty(globalThis, 'crypto', original.crypto);
    else delete globalThis.crypto;
  });
  return {
    api, doc, refs, helpers, logs, timers, resolveCalls,
    element(ref, { tag = 'span', text = 'old', attributes = {}, parent = doc.body } = {}) {
      const element = doc.createElement(tag);
      if (text !== null && text !== '') element.appendChild(doc.createTextNode(text));
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      if (parent) parent.appendChild(element);
      refs.set(ref, element);
      elementRefs.set(element, ref);
      return element;
    },
    tick(ms) {
      now += ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= now).sort((left, right) => left[1].at - right[1].at);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.callback();
      }
    },
    advanceWithoutTimers(ms) { now += ms; },
    liveWrites() { return doc.writes.filter((write) => write.element?.isConnected); },
  };
}

function fails(code, operation, message) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof PatchError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test('apply returns an opaque document handle and clone-safe owned summaries', (t) => {
  const f = fixture(t);
  const element = f.element('e1');
  const patch = f.api.apply('owner-a', [{
    target: { locator: { steps: [{ kind: 'testId', value: 'e1' }] } },
    styles: { color: 'red !important', 'margin-left': '3px' },
    attributes: { class: 'preview', title: '', 'aria-label': 'Preview', 'data-patch': 'true' },
    text: '<b>plain text</b>',
  }], { label: 'Preview' });
  assert.match(patch.id, /^p_[0-9a-f]{48}$/);
  assert.equal(patch.label, 'Preview');
  assert.equal(patch.changeCount, 1);
  assert.equal(patch.expiresAt - patch.createdAt, PATCH_LIMITS.defaultTtlMs);
  assert.ok(patch.bytes > 0 && patch.bytes <= PATCH_LIMITS.maxHistoryBytes);
  assert.equal(patch.sourceChanged, false);
  assert.equal(element.style.getPropertyValue('color'), 'red');
  assert.equal(element.style.getPropertyPriority('color'), 'important');
  assert.equal(element.textContent, '<b>plain text</b>');
  assert.equal(element.children.length, 0);
  assert.equal(patch.targets[0].ref, 'e1');
  assert.equal(patch.targets[0].text, '<b>plain text</b>');
  assert.deepEqual(f.api.list('owner-b'), []);
  patch.targets[0].text = 'tampered';
  const list = f.api.list('owner-a');
  assert.equal(list[0].targets[0].text, '<b>plain text</b>');
  list[0].id = 'tampered';
  assert.notEqual(f.api.list('owner-a')[0].id, 'tampered');
});

test('HTTP-safe opaque handles require getRandomValues but not randomUUID', (t) => {
  const nativeCrypto = globalThis.crypto;
  const f = fixture(t);
  let calls = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues(array) {
        calls++;
        return nativeCrypto.getRandomValues(array);
      },
    },
  });
  f.element('first');
  f.element('second');
  assert.equal(globalThis.crypto.randomUUID, undefined);
  const first = f.api.apply('a', [{ target: { ref: 'first' }, text: 'preview' }]);
  const second = f.api.apply('a', [{ target: { ref: 'second' }, text: 'preview' }]);
  assert.equal(calls, 2);
  assert.match(first.id, /^p_[0-9a-f]{48}$/);
  assert.notEqual(first.id, second.id);
});

test('all change shapes and targets are validated before any live mutation', (t) => {
  const f = fixture(t);
  const first = f.element('first');
  const second = f.element('second');
  f.doc.writes.length = 0;
  fails('forbidden', () => f.api.apply('a', [
    { target: { ref: 'first' }, text: 'changed' },
    { target: { ref: 'second' }, attributes: { href: 'https://example.test' } },
  ]));
  assert.equal(first.textContent, 'old');
  assert.equal(f.liveWrites().length, 0);
  fails('bad_request', () => f.api.apply('a', [
    { target: { ref: 'first' }, text: 'changed' },
    { target: { ref: 'missing' }, text: 'changed' },
  ]), /Unknown ref/);
  assert.deepEqual(f.resolveCalls.map((target) => target.ref), ['first', 'missing']);
  assert.equal(first.textContent, 'old');
  assert.equal(f.liveWrites().length, 0);
  fails('bad_request', () => f.api.apply('a', [
    { target: { ref: 'first' }, attributes: { title: 'changed' } },
    { target: { ref: 'second' }, styles: { color: 'not-valid-color' } },
  ]), /CSS declaration/);
  assert.equal(second.hasAttribute('style'), false);
  assert.equal(first.hasAttribute('title'), false);
  assert.equal(f.liveWrites().length, 0);
});

test('application failures before or after a setter roll back the entire journal', (t) => {
  const f = fixture(t);
  const first = f.element('first', { attributes: { style: 'color: blue !important; ' } });
  const originalText = first.firstChild;
  const second = f.element('second');
  for (const phase of ['before', 'after']) {
    second.fail('title', phase);
    fails('patch_failed', () => f.api.apply('a', [
      { target: { ref: 'first' }, styles: { color: 'red' }, attributes: { 'data-new': 'yes' }, text: 'new' },
      { target: { ref: 'second' }, attributes: { title: 'new' } },
    ]), /transaction was reversed/i);
    assert.equal(first.getAttribute('style'), 'color: blue !important; ');
    assert.equal(first.style.getPropertyPriority('color'), 'important');
    assert.equal(first.hasAttribute('data-new'), false);
    assert.equal(first.firstChild, originalText);
    assert.equal(originalText.data, 'old');
    assert.equal(second.hasAttribute('title'), false);
    assert.deepEqual(f.api.list('a'), []);
    assert.equal(f.timers.size, 0);
  }
});

test('rollback restores exact attribute presence, raw styles, priorities, and text identities', (t) => {
  const f = fixture(t);
  const rawStyle = 'color: blue !important; margin-left: 7px !important; ';
  const first = f.element('first', { attributes: { style: rawStyle, class: '' } });
  const oldFirst = first.firstChild;
  const oldSecond = f.doc.createTextNode(' tail');
  first.appendChild(oldSecond);
  const empty = f.element('empty', { text: '' });
  const unstyled = f.element('unstyled');
  const patch = f.api.apply('a', [
    { target: { ref: 'first' }, styles: { color: 'red', margin: '2px' }, attributes: { class: null, title: '', 'data-new': 'yes' }, text: 'new' },
    { target: { ref: 'empty' }, text: '' },
    { target: { ref: 'unstyled' }, styles: { width: '24px' }, attributes: { hidden: '' } },
  ]);
  assert.equal(first.firstChild, oldFirst);
  assert.equal(first.childNodes[1], oldSecond);
  assert.equal(oldSecond.data, '');
  assert.equal(empty.childNodes.length, 1);
  assert.deepEqual(f.api.rollback('a', patch.id), { rolledBack: [patch.id] });
  assert.equal(first.getAttribute('style'), rawStyle);
  assert.equal(first.style.getPropertyValue('margin-left'), '7px');
  assert.equal(first.style.getPropertyPriority('margin-left'), 'important');
  assert.equal(first.style.getPropertyPriority('color'), 'important');
  assert.equal(first.hasAttribute('class'), true);
  assert.equal(first.getAttribute('class'), '');
  assert.equal(first.hasAttribute('title'), false);
  assert.equal(first.hasAttribute('data-new'), false);
  assert.deepEqual(first.childNodes, [oldFirst, oldSecond]);
  assert.equal(oldFirst.data, 'old');
  assert.equal(oldSecond.data, ' tail');
  assert.equal(empty.childNodes.length, 0);
  assert.equal(unstyled.hasAttribute('style'), false);
  assert.equal(unstyled.hasAttribute('hidden'), false);
});

test('null removes a style and present-empty style survives rollback', (t) => {
  const f = fixture(t);
  const first = f.element('first', { attributes: { style: 'color: blue !important;' } });
  const second = f.element('second', { attributes: { style: '' } });
  const patch = f.api.apply('a', [
    { target: { ref: 'first' }, styles: { color: null } },
    { target: { ref: 'second' }, styles: { width: '10px' } },
  ]);
  assert.equal(first.style.getPropertyValue('color'), '');
  f.api.rollback('a', patch.id);
  assert.equal(first.style.getPropertyPriority('color'), 'important');
  assert.equal(second.hasAttribute('style'), true);
  assert.equal(second.getAttribute('style'), '');
});

test('overlapping and nested active patches are explicitly rejected', (t) => {
  const f = fixture(t);
  const parent = f.element('parent', { tag: 'div', text: '' });
  const child = f.element('child', { parent });
  const patch = f.api.apply('a', [{ target: { ref: 'parent' }, attributes: { title: 'preview' } }]);
  fails('patch_conflict', () => f.api.apply('a', [{ target: { ref: 'parent' }, attributes: { class: 'second' } }]), /Overlapping or nested/);
  fails('patch_conflict', () => f.api.apply('b', [{ target: { ref: 'child' }, text: 'second' }]));
  assert.equal(parent.hasAttribute('class'), false);
  assert.equal(child.textContent, 'old');
  f.api.rollback('a', patch.id);
  const childPatch = f.api.apply('a', [{ target: { ref: 'child' }, text: 'child preview' }]);
  fails('patch_conflict', () => f.api.apply('a', [{ target: { ref: 'parent' }, attributes: { title: 'second' } }]));
  f.api.commit('a', childPatch.id);
  assert.ok(f.api.apply('a', [{ target: { ref: 'parent' }, attributes: { title: 'allowed' } }]).id);
});

test('owner rollback preflights every patch and rolls back in reverse application order', (t) => {
  const f = fixture(t);
  const elements = ['first', 'second', 'third'].map((ref) => f.element(ref));
  const patches = elements.map((_element, index) => f.api.apply('a', [{
    target: { ref: ['first', 'second', 'third'][index] }, attributes: { title: `patch-${index}` },
  }]));
  elements[0].setAttribute('title', 'app change');
  f.doc.writes.length = 0;
  fails('patch_conflict', () => f.api.rollback('a'));
  assert.equal(f.liveWrites().length, 0);
  assert.equal(elements[2].getAttribute('title'), 'patch-2');
  elements[0].setAttribute('title', 'patch-0');
  f.doc.writes.length = 0;
  assert.deepEqual(f.api.rollback('a').rolledBack, patches.map((patch) => patch.id).reverse());
  assert.deepEqual(f.liveWrites().filter((write) => write.name === 'title').map((write) => write.element), [...elements].reverse());
});

test('rollback detects attribute and unrelated inline-style application changes without partial success', (t) => {
  const f = fixture(t);
  const first = f.element('first');
  const second = f.element('second');
  const patch = f.api.apply('a', [
    { target: { ref: 'first' }, text: 'preview' },
    { target: { ref: 'second' }, styles: { color: 'red' }, attributes: { title: 'preview' } },
  ]);
  second.setAttribute('title', 'app');
  fails('patch_conflict', () => f.api.rollback('a', patch.id));
  assert.equal(first.textContent, 'preview');
  assert.equal(second.getAttribute('title'), 'app');
  second.setAttribute('title', 'preview');
  const patchedStyle = second.getAttribute('style');
  second.style.setProperty('width', '22px');
  fails('patch_conflict', () => f.api.rollback('a', patch.id));
  assert.equal(first.textContent, 'preview');
  assert.equal(second.style.getPropertyValue('width'), '22px');
  second.setAttribute('style', patchedStyle);
  f.api.rollback('a', patch.id);
  assert.equal(first.textContent, 'old');
});

test('equal replacement text nodes and detached targets are conflicts, never re-resolved', (t) => {
  const f = fixture(t);
  const first = f.element('first');
  const patch = f.api.apply('a', [{ target: { ref: 'first' }, text: 'preview' }]);
  const patchedNode = first.firstChild;
  first.textContent = 'preview';
  fails('patch_conflict', () => f.api.rollback('a', patch.id));
  assert.notEqual(first.firstChild, patchedNode);
  assert.equal(f.resolveCalls.length, 1);
  first.remove();
  const replacement = f.element('first', { text: 'replacement' });
  fails('patch_conflict', () => f.api.rollback('a', patch.id), /detached/);
  assert.equal(replacement.textContent, 'replacement');
  assert.equal(f.resolveCalls.length, 1);
});

test('rollback setter failure is compensated to the applied state and history stays live', (t) => {
  const f = fixture(t);
  const element = f.element('e', { attributes: { title: 'original', class: 'original' } });
  const patch = f.api.apply('a', [{ target: { ref: 'e' }, attributes: { title: 'preview', class: 'preview' } }]);
  element.fail('title', 'before', 'original');
  fails('patch_failed', () => f.api.rollback('a', patch.id), /transaction was reversed/i);
  assert.equal(element.getAttribute('title'), 'preview');
  assert.equal(element.getAttribute('class'), 'preview');
  assert.equal(f.api.list('a')[0].id, patch.id);
  f.api.rollback('a', patch.id);
  assert.equal(element.getAttribute('title'), 'original');
  assert.equal(element.getAttribute('class'), 'original');
});

test('wrong-owner calls never modify or release another owner handle', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  const patch = f.api.apply('owner-a', [{ target: { ref: 'e' }, text: 'preview' }]);
  fails('forbidden', () => f.api.rollback('owner-b', patch.id));
  fails('forbidden', () => f.api.commit('owner-b', patch.id));
  assert.deepEqual(f.api.releaseOwner('owner-b'), { released: [], rolledBack: [], errors: [] });
  assert.deepEqual(f.api.list('owner-b'), []);
  assert.equal(element.textContent, 'preview');
  assert.equal(f.api.list('owner-a')[0].id, patch.id);
  f.api.commit('owner-a', patch.id);
  fails('forbidden', () => f.api.rollback('owner-b', patch.id));
  fails('expired', () => f.api.rollback('owner-a', patch.id));
  assert.equal(element.textContent, 'preview');
});

test('expiry restores the original DOM and invalidates the owned handle', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  const node = element.firstChild;
  const patch = f.api.apply('a', [{ target: { ref: 'e' }, text: 'preview' }], { ttlMs: 10 });
  f.tick(9);
  assert.equal(element.textContent, 'preview');
  f.tick(1);
  assert.equal(element.textContent, 'old');
  assert.equal(element.firstChild, node);
  assert.deepEqual(f.api.list('a'), []);
  fails('expired', () => f.api.rollback('a', patch.id));
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.logs, []);
});

test('expiry reports conflicts and never overwrites application updates', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  const patch = f.api.apply('a', [{ target: { ref: 'e' }, text: 'preview' }], { ttlMs: 1 });
  element.firstChild.data = 'app';
  f.tick(1);
  assert.equal(element.textContent, 'app');
  assert.deepEqual(f.api.list('a'), []);
  assert.ok(f.logs.some((log) => log.includes(patch.id) && log.includes('patch_conflict')));
  assert.equal(f.timers.size, 0);
  fails('expired', () => f.api.commit('a', patch.id));
});

test('releaseOwner and dispose return explicit conflicts and release all selected timers', (t) => {
  const f = fixture(t);
  const first = f.element('first');
  const second = f.element('second');
  const third = f.element('third');
  const a1 = f.api.apply('a', [{ target: { ref: 'first' }, text: 'a1' }]);
  const a2 = f.api.apply('a', [{ target: { ref: 'second' }, text: 'a2' }]);
  const b1 = f.api.apply('b', [{ target: { ref: 'third' }, text: 'b1' }]);
  second.firstChild.data = 'application update';
  const released = f.api.releaseOwner('a');
  assert.deepEqual(released.released, [a2.id, a1.id]);
  assert.deepEqual(released.rolledBack, [a1.id]);
  assert.equal(released.errors.length, 1);
  assert.equal(released.errors[0].id, a2.id);
  assert.equal(released.errors[0].code, 'patch_conflict');
  assert.equal(first.textContent, 'old');
  assert.equal(second.textContent, 'application update');
  assert.equal(third.textContent, 'b1');
  assert.equal(f.timers.size, 1);
  const disposed = f.api.dispose();
  assert.deepEqual(disposed, { released: [b1.id], rolledBack: [b1.id], errors: [] });
  assert.equal(third.textContent, 'old');
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.api.dispose(), { released: [], rolledBack: [], errors: [] });
  fails('expired', () => f.api.apply('a', [{ target: { ref: 'first' }, text: 'new' }]));
});

test('dispose returns conflicts instead of swallowing them', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  const patch = f.api.apply('a', [{ target: { ref: 'e' }, attributes: { title: 'preview' } }]);
  element.setAttribute('title', 'app');
  const result = f.api.dispose();
  assert.equal(result.errors[0].id, patch.id);
  assert.equal(result.errors[0].code, 'patch_conflict');
  assert.deepEqual(result.rolledBack, []);
  assert.equal(element.getAttribute('title'), 'app');
  assert.equal(f.timers.size, 0);
});

test('commit only forgets owned rollback history and never claims source persistence', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  const node = element.firstChild;
  const patch = f.api.apply('a', [{ target: { ref: 'e' }, text: 'preview' }]);
  f.doc.writes.length = 0;
  assert.deepEqual(f.api.commit('a', patch.id), { id: patch.id, committed: true, sourceChanged: false });
  assert.equal(element.textContent, 'preview');
  assert.equal(element.firstChild, node);
  assert.equal(f.liveWrites().length, 0);
  assert.deepEqual(f.api.list('a'), []);
  assert.equal(f.timers.size, 0);
  fails('expired', () => f.api.rollback('a', patch.id));
  const next = f.api.apply('a', [{ target: { ref: 'e' }, text: 'next' }]);
  assert.notEqual(next.id, patch.id);
  element.firstChild.data = 'app';
  f.api.commit('a', next.id);
  assert.equal(element.textContent, 'app');
});

test('unsupported executable, URL, input, and CSS surfaces are rejected before mutation', (t) => {
  const f = fixture(t);
  f.element('e');
  f.doc.writes.length = 0;
  for (const name of ['onclick', 'onload', 'srcdoc', 'value', 'type', 'href', 'src', 'style', 'id', 'xlink:href', 'formaction']) {
    fails('forbidden', () => f.api.apply('a', [{ target: { ref: 'e' }, attributes: { [name]: 'unsafe' } }]));
  }
  for (const [name, value] of [
    ['color', 'red; width: 100px'], ['color', 'var(--unknown)'], ['color', 'expression(1)'],
    ['background-image', 'url(https://example.test/pixel)'], ['background', 'u\\72l(https://example.test/pixel)'],
    ['background-image', 'image-set("https://example.test/pixel" 1x)'], ['color', 'red/*comment*/'],
    ['background-image', 'inherit'], ['filter', 'revert'], ['cursor', 'unset'],
    ['font-family', 'DownloadedFont'], ['--custom', 'red'], ['-moz-binding', 'none'],
  ]) {
    fails('forbidden', () => f.api.apply('a', [{ target: { ref: 'e' }, styles: { [name]: value } }]));
  }
  fails('bad_request', () => f.api.apply('a', [{ target: { ref: 'e' }, attributes: { title: 4 } }]));
  fails('bad_request', () => f.api.apply('a', [{ target: { ref: 'e' }, html: '<b>new</b>' }]));
  assert.equal(f.liveWrites().length, 0);
});

test('text and metadata patches reject form controls and sensitive composed regions', (t) => {
  const f = fixture(t);
  const forbidden = [
    ...['input', 'textarea', 'select', 'button', 'script', 'style', 'template'].map((tag) => f.element(tag, { tag })),
    f.element('password', { tag: 'input', attributes: { type: 'password' } }),
    f.element('otp', { attributes: { autocomplete: 'one-time-code' } }),
    f.element('role', { attributes: { role: 'textbox presentation' } }),
    f.element('editable', { attributes: { contenteditable: 'true' } }),
    f.element('private', { attributes: { 'data-private': '' } }),
    f.element('custom', { tag: 'custom-preview' }),
    f.element('customized', { attributes: { is: 'custom-preview' } }),
  ];
  const form = f.element('form', { tag: 'form', text: '' });
  forbidden.push(f.element('form-child', { parent: form }));
  const secret = f.element('secret', { tag: 'div', text: '', attributes: { 'data-sensitive': '' } });
  forbidden.push(f.element('secret-child', { parent: secret }));
  const wrapper = f.element('wrapper', { tag: 'div', text: '' });
  f.element('wrapped-password', { tag: 'input', parent: wrapper, attributes: { type: 'password' } });
  forbidden.push(wrapper);
  const host = f.element('host', { tag: 'credential-widget', text: '', attributes: { 'data-private': '' } });
  host.shadowRoot = new MockNode(11, f.doc);
  host.shadowRoot.host = host;
  forbidden.push(f.element('shadow-child', { parent: host.shadowRoot }));
  for (const element of forbidden) {
    const ref = f.helpers.refFor(element);
    fails('forbidden', () => f.api.apply('a', [{ target: { ref }, text: 'new' }]));
    fails('forbidden', () => f.api.apply('a', [{ target: { ref }, attributes: { title: 'new' } }]));
  }
  const nonleaf = f.element('nonleaf', { text: '' });
  f.element('nested', { parent: nonleaf });
  fails('forbidden', () => f.api.apply('a', [{ target: { ref: 'nonleaf' }, text: 'new' }]), /plain-text leaf/);
  const svg = f.element('svg');
  svg.namespaceURI = 'http://www.w3.org/2000/svg';
  fails('forbidden', () => f.api.apply('a', [{ target: { ref: 'svg' }, attributes: { class: 'new' } }]));
});

test('payload, change, history, and TTL limits are strict and leave the document untouched', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  const change = { target: { ref: 'e' }, text: 'new' };
  for (const value of [[], new Array(51).fill(change), null]) fails('bad_request', () => f.api.apply('a', value));
  for (const ttlMs of [null, 0, -1, NaN, Infinity, 1.5, PATCH_LIMITS.maxTtlMs + 1]) {
    fails('bad_request', () => f.api.apply('a', [change], { ttlMs }));
  }
  fails('bad_request', () => f.api.apply('a', [change], { label: 'x'.repeat(129) }));
  fails('bad_request', () => f.api.apply('', [change]));
  fails('bad_request', () => f.api.apply('a', [{ target: { ref: 'e', locator: { steps: [] } }, text: 'new' }]));
  fails('bad_request', () => f.api.apply('a', [{ target: { ref: 'e' }, text: '🙂'.repeat(17_000) }]), /payload/);
  const rawLarge = new Array(20).fill({ target: { ref: 'e' }, styles: { color: `${' '.repeat(4000)}red` } });
  fails('bad_request', () => f.api.apply('a', rawLarge), /payload/);
  assert.equal(element.textContent, 'old');
  element.firstChild.data = 'x'.repeat(PATCH_LIMITS.maxHistoryBytes);
  fails('bad_request', () => f.api.apply('a', [change]), /history byte limit/);
  assert.equal(element.firstChild.data.length, PATCH_LIMITS.maxHistoryBytes);
  assert.deepEqual(f.api.list('a'), []);
  assert.equal(f.timers.size, 0);
});

test('the document-wide active patch cap frees capacity on commit', (t) => {
  const f = fixture(t);
  const patches = [];
  for (let index = 0; index < PATCH_LIMITS.maxActivePatches; index++) {
    f.element(`e${index}`);
    patches.push(f.api.apply(`owner-${index % 2}`, [{ target: { ref: `e${index}` }, attributes: { title: 'preview' } }]));
  }
  f.element('extra');
  fails('bad_request', () => f.api.apply('new-owner', [{ target: { ref: 'extra' }, text: 'new' }]), /active patch limit/);
  f.api.commit('owner-0', patches[0].id);
  assert.ok(f.api.apply('new-owner', [{ target: { ref: 'extra' }, text: 'new' }]).id);
  assert.equal(f.timers.size, PATCH_LIMITS.maxActivePatches);
});

test('replaced documents and foreign document elements invalidate patches without replay', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  const patch = f.api.apply('a', [{ target: { ref: 'e' }, text: 'preview' }]);
  const other = new MockDocument();
  const foreign = other.createElement('span');
  other.body.appendChild(foreign);
  f.refs.set('foreign', foreign);
  fails('patch_conflict', () => f.api.apply('a', [{ target: { ref: 'foreign' }, text: 'new' }]));
  globalThis.document = other;
  fails('expired', () => f.api.rollback('a', patch.id), /replaced document/);
  assert.equal(element.textContent, 'preview');
  const result = f.api.dispose();
  assert.equal(result.errors[0].id, patch.id);
  assert.equal(result.errors[0].code, 'expired');
  assert.equal(f.timers.size, 0);
});

test('document.open-style root replacement also invalidates existing handles', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  const patch = f.api.apply('a', [{ target: { ref: 'e' }, text: 'preview' }]);
  f.doc.removeChild(f.doc.documentElement);
  f.doc.documentElement = f.doc.createElement('html');
  f.doc.appendChild(f.doc.documentElement);
  fails('expired', () => f.api.commit('a', patch.id));
  assert.equal(element.textContent, 'preview');
  assert.equal(f.api.releaseOwner('a').errors[0].code, 'expired');
  assert.equal(f.timers.size, 0);
});

test('summary failures and reentrant calls cannot leave a partially applied patch', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  f.helpers.summarize = () => { throw new Error('Summary unavailable'); };
  fails('patch_failed', () => f.api.apply('a', [{ target: { ref: 'e' }, text: 'preview' }]));
  assert.equal(element.textContent, 'old');
  assert.equal(f.timers.size, 0);
  f.helpers.summarize = () => f.api.list('a')[0];
  fails('patch_conflict', () => f.api.apply('a', [{ target: { ref: 'e' }, text: 'preview' }]), /already running/);
  assert.equal(element.textContent, 'old');
  assert.deepEqual(f.api.list('a'), []);
});

test('wrong-owner expired-handle calls cannot trigger another owner expiry cleanup', (t) => {
  const f = fixture(t);
  const element = f.element('e');
  const patch = f.api.apply('a', [{ target: { ref: 'e' }, text: 'preview' }], { ttlMs: 1 });
  f.advanceWithoutTimers(1);
  fails('forbidden', () => f.api.rollback('b', patch.id));
  fails('forbidden', () => f.api.commit('b', patch.id));
  assert.equal(element.textContent, 'preview');
  f.tick(0);
  assert.equal(element.textContent, 'old');
});

test('invalid apply and read-only list never mutate expired pending patches', (t) => {
  const f = fixture(t);
  const expired = f.element('expired');
  const fresh = f.element('fresh');
  const patch = f.api.apply('a', [{ target: { ref: 'expired' }, text: 'preview' }], { ttlMs: 1 });
  f.advanceWithoutTimers(1);
  fails('bad_request', () => f.api.apply('a', [
    { target: { ref: 'fresh' }, text: 'new' },
    { target: { ref: 'missing' }, text: 'new' },
  ]));
  assert.deepEqual(f.api.list('a'), []);
  fails('expired', () => f.api.commit('a', patch.id));
  assert.equal(expired.textContent, 'preview');
  assert.equal(fresh.textContent, 'old');
  f.tick(0);
  assert.equal(expired.textContent, 'old');
});
