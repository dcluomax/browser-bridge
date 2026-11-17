import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modifierMask, parseKeyCombo, producesText } from '../src/shared/keys.ts';

test('named keys resolve case-insensitively', () => {
  assert.equal(parseKeyCombo('Enter').def.code, 'Enter');
  assert.equal(parseKeyCombo('enter').def.text, '\r');
  assert.equal(parseKeyCombo('ArrowLeft').def.keyCode, 37);
  assert.equal(parseKeyCombo('PageDown').def.key, 'PageDown');
  assert.equal(parseKeyCombo('F5').def.keyCode, 116);
  assert.equal(parseKeyCombo('Escape').def.key, 'Escape');
});

test('single characters map to physical keys', () => {
  assert.deepEqual(parseKeyCombo('a').def, { key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
  assert.equal(parseKeyCombo('7').def.code, 'Digit7');
  assert.equal(parseKeyCombo('/').def.code, 'Slash');
  assert.equal(parseKeyCombo('?').def.code, 'Slash');
  assert.equal(parseKeyCombo(' ').def.code, 'Space');
  assert.equal(parseKeyCombo('é').def.text, 'é');
});

test('chords parse modifiers and aliases', () => {
  const combo = parseKeyCombo('Ctrl+Shift+a');
  assert.deepEqual(combo.modifiers, ['Control', 'Shift']);
  assert.equal(combo.def.key, 'A');
  assert.equal(modifierMask(combo.modifiers), 10);
  assert.equal(parseKeyCombo('Control++').def.key, '+');
  assert.deepEqual(parseKeyCombo('Cmd+K').modifiers, ['Meta']);
  assert.equal(parseKeyCombo('Shift').def.code, 'ShiftLeft');
});

test('text production respects command modifiers', () => {
  assert.equal(producesText(parseKeyCombo('a')), true);
  assert.equal(producesText(parseKeyCombo('Shift+a')), true);
  assert.equal(producesText(parseKeyCombo('Control+a')), false);
  assert.equal(producesText(parseKeyCombo('Tab')), false);
});

test('unknown key names are rejected', () => {
  assert.throws(() => parseKeyCombo('NotAKey'), /Unknown key/);
  assert.throws(() => parseKeyCombo(''), /non-empty/);
});
