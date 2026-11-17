import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLocator } from '../src/shared/locators.ts';

test('parses chained finders and preserves frame selection', () => {
  const locator = parseLocator({
    frameId: 3,
    steps: [
      { kind: 'css', value: 'section' },
      { kind: 'role', value: 'button', name: 'Save', exact: true, includeHidden: false },
      { kind: 'filter', value: 'Save' },
      { kind: 'nth', index: -1 },
    ],
  });
  assert.equal(locator.frameId, 3);
  assert.deepEqual(locator.steps[1], { kind: 'role', value: 'button', name: 'Save', exact: true, includeHidden: false });
  assert.deepEqual(locator.steps[3], { kind: 'nth', index: -1 });
});

test('preserves Firefox frame ids larger than int32', () => {
  assert.equal(parseLocator({ frameId: 19_327_352_834, steps: [{ kind: 'css', value: 'button' }] }).frameId, 19_327_352_834);
});

for (const kind of ['css', 'role', 'text', 'label', 'placeholder', 'testId', 'altText', 'title']) {
  test(`accepts ${kind} finder`, () => {
    assert.equal(parseLocator({ steps: [{ kind, value: 'target' }] }).steps[0].kind, kind);
  });
}

for (const [label, value] of [
  ['missing locator', undefined],
  ['empty steps', { steps: [] }],
  ['too many steps', { steps: Array.from({ length: 17 }, () => ({ kind: 'css', value: 'div' })) }],
  ['invalid kind', { steps: [{ kind: 'evaluate', value: '1+1' }] }],
  ['unknown root property', { steps: [{ kind: 'css', value: 'div' }], expression: '1+1' }],
  ['unknown step property', { steps: [{ kind: 'css', value: 'div', evaluate: true }] }],
  ['empty selector', { steps: [{ kind: 'css', value: '' }] }],
  ['oversized selector', { steps: [{ kind: 'css', value: 'a'.repeat(4097) }] }],
  ['invalid exact flag', { steps: [{ kind: 'text', value: 'a', exact: 'true' }] }],
  ['irrelevant exact flag', { steps: [{ kind: 'testId', value: 'a', exact: true }] }],
  ['invalid name', { steps: [{ kind: 'role', value: 'button', name: 3 }] }],
  ['invalid includeHidden flag', { steps: [{ kind: 'role', value: 'button', includeHidden: 1 }] }],
  ['nth without finder', { steps: [{ kind: 'nth', index: 0 }] }],
  ['filter without finder', { steps: [{ kind: 'filter', value: 'a' }] }],
  ['fractional nth', { steps: [{ kind: 'css', value: 'div' }, { kind: 'nth', index: 0.5 }] }],
  ['negative frame', { frameId: -1, steps: [{ kind: 'css', value: 'div' }] }],
  ['fractional frame', { frameId: 0.5, steps: [{ kind: 'css', value: 'div' }] }],
  ['string frame', { frameId: '3', steps: [{ kind: 'css', value: 'div' }] }],
  ['unsafe frame', { frameId: Number.MAX_SAFE_INTEGER + 1, steps: [{ kind: 'css', value: 'div' }] }],
] as const) {
  test(`rejects ${label}`, () => assert.throws(() => parseLocator(value)));
}
