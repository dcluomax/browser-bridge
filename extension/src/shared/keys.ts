export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  /** Text produced by the key when no command modifier is held. */
  text?: string;
  location?: number;
}

export interface KeyPress {
  modifiers: Modifier[];
  def: KeyDef;
}

/** Bit values used by the Chrome DevTools Protocol `modifiers` field. */
export const MODIFIER_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const MODIFIER_ALIASES: Record<string, Modifier> = {
  alt: 'Alt',
  option: 'Alt',
  control: 'Control',
  ctrl: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta',
  windows: 'Meta',
  super: 'Meta',
  shift: 'Shift',
};

const NAMED: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  capslock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
  contextmenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
};

for (let i = 1; i <= 12; i++) {
  NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

/** Unshifted punctuation: code and Windows virtual key code. */
const PUNCTUATION: Record<string, [string, number]> = {
  '-': ['Minus', 189],
  '=': ['Equal', 187],
  '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  '\\': ['Backslash', 220],
  ';': ['Semicolon', 186],
  "'": ['Quote', 222],
  ',': ['Comma', 188],
  '.': ['Period', 190],
  '/': ['Slash', 191],
  '`': ['Backquote', 192],
};

/** Shifted characters mapped to the physical key that produces them on a US layout. */
const SHIFTED: Record<string, string> = {
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
};

function charDef(ch: string, shift: boolean): KeyDef {
  if (/^[a-z]$/i.test(ch)) {
    const upper = ch.toUpperCase();
    const text = shift ? upper : ch;
    return { key: text, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text };
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), text: ch };
  }
  const punct = PUNCTUATION[ch];
  if (punct) {
    return { key: ch, code: punct[0], keyCode: punct[1], text: ch };
  }
  const base = SHIFTED[ch];
  if (base !== undefined) {
    const baseDef = charDef(base, false);
    return { key: ch, code: baseDef.code, keyCode: baseDef.keyCode, text: ch };
  }
  return { key: ch, code: '', keyCode: 0, text: ch };
}

/**
 * Parses a key or chord such as `Enter`, `a`, `Shift+Tab`, `Control+A` or `Control++`.
 * Modifier aliases (Ctrl, Cmd, Option, Win) are accepted case-insensitively.
 */
export function parseKeyCombo(input: string): KeyPress {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Key must be a non-empty string such as "Enter" or "Control+A".');
  }
  const modifiers: Modifier[] = [];
  let rest = input;
  for (;;) {
    const match = /^(alt|option|control|ctrl|meta|cmd|command|win|windows|super|shift)\+(.+)$/i.exec(rest);
    if (!match) break;
    const mod = MODIFIER_ALIASES[match[1].toLowerCase()];
    if (!modifiers.includes(mod)) modifiers.push(mod);
    rest = match[2];
  }
  const shift = modifiers.includes('Shift');
  const named = NAMED[rest.toLowerCase()];
  if (named && rest.length > 1) return { modifiers, def: { ...named } };
  if (rest === ' ') return { modifiers, def: { ...NAMED[' '] } };
  if ([...rest].length === 1) return { modifiers, def: charDef(rest, shift) };
  if (named) return { modifiers, def: { ...named } };
  throw new Error(`Unknown key "${rest}". Use a single character or a name such as Enter, Tab, Escape, ArrowDown, PageDown, F5.`);
}

export function modifierMask(modifiers: readonly Modifier[]): number {
  return modifiers.reduce((mask, mod) => mask | MODIFIER_BITS[mod], 0);
}

/** True when the chord should insert text (no Control/Alt/Meta held and the key has text). */
export function producesText(press: KeyPress): boolean {
  return Boolean(press.def.text) && !press.modifiers.some((m) => m === 'Control' || m === 'Alt' || m === 'Meta');
}
