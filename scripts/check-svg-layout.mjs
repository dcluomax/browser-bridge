#!/usr/bin/env node
/**
 * Automated SVG layout, text-overflow, and accessibility guard for docs/assets/*.svg.
 * Estimates worst-case glyph widths across proportional (Segoe UI / SF Pro / DejaVu Sans)
 * and monospace (Consolas / Menlo / DejaVu Sans Mono) fonts and verifies that every <text>
 * and <rect> stays cleanly inside its parent container and the root SVG viewBox.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs', 'assets');

function decodeXml(str) {
  return str
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function estimateTextWidth(rawText, fontSize, isMono, fontWeight, letterSpacing = 0) {
  const text = decodeXml(rawText);
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isMono) {
      units += code > 0x2e80 ? 1.85 : 0.62;
    } else if (code > 0x2e80) {
      // CJK ideographs
      units += 1.02;
    } else if ('MW@#%&QGO0'.includes(ch)) {
      units += 0.78;
    } else if (ch >= 'A' && ch <= 'Z') {
      units += 0.67;
    } else if ('ilI1|.,:;\'"!()`[] '.includes(ch)) {
      units += 0.31;
    } else if ('fjt-r/\\'.includes(ch)) {
      units += 0.39;
    } else {
      units += 0.56;
    }
  }
  const weightBoost = fontWeight >= 800 ? 1.08 : fontWeight >= 700 ? 1.05 : fontWeight >= 600 ? 1.02 : 1.0;
  return units * fontSize * weightBoost + Math.max(0, [...text].length - 1) * letterSpacing;
}

function parseAttrs(attrText) {
  const out = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrText)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function parseTranslate(transform) {
  if (!transform) return [0, 0];
  const m = /translate\(\s*([-\d.]+)(?:[\s,]+([-\d.]+))?\s*\)/.exec(transform);
  if (!m) return [0, 0];
  return [Number(m[1]) || 0, Number(m[2]) || 0];
}

const errors = [];
const svgFiles = readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.svg')).sort();

for (const file of svgFiles) {
  const raw = readFileSync(join(ASSETS_DIR, file), 'utf8');
  if (!raw.includes('role="img"') || !raw.includes('<title ') || !raw.includes('<desc ')) {
    errors.push(`${file}: missing accessible role="img", <title>, or <desc>`);
  }

  const stack = [];
  const tokenRe = /<\/?([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  let match;
  let svgWidth = 1200;

  while ((match = tokenRe.exec(raw)) !== null) {
    const [full, tag, attrStr, selfClose] = match;
    const isClose = full.startsWith('</');
    if (isClose) {
      stack.pop();
      continue;
    }
    const attrs = parseAttrs(attrStr);
    const parent = stack[stack.length - 1] ?? null;
    const [dx, dy] = parseTranslate(attrs.transform);
    const node = {
      tag,
      attrs,
      ox: (parent?.ox ?? 0) + dx,
      oy: (parent?.oy ?? 0) + dy,
      fontSize: attrs['font-size'] ? Number(attrs['font-size']) : (parent?.fontSize ?? 14),
      fontWeight: attrs['font-weight'] ? Number(attrs['font-weight']) || 700 : (parent?.fontWeight ?? 400),
      fontFamily: attrs['font-family'] || (parent?.fontFamily ?? ''),
      rects: [],
    };

    if (tag === 'svg') {
      svgWidth = Number(attrs.width) || 1200;
    } else if (tag === 'rect' && parent) {
      const rx = Number(attrs.x ?? 0);
      const ry = Number(attrs.y ?? 0);
      const rw = Number(attrs.width ?? 0);
      const rh = Number(attrs.height ?? 0);
      parent.rects.push({ rx, ry, rw, rh });
      const absLeft = node.ox + rx;
      const absRight = absLeft + rw;
      if (rw < svgWidth - 10 && (absLeft < 24 || absRight > svgWidth - 24)) {
        errors.push(`${file}: <rect> [${absLeft}..${absRight}] violates 24px outer canvas margin (svgWidth=${svgWidth})`);
      }
    } else if (tag === 'text') {
      const closeIdx = raw.indexOf('</text>', tokenRe.lastIndex);
      const inner = closeIdx >= 0 ? raw.slice(tokenRe.lastIndex, closeIdx).replace(/<[^>]+>/g, '') : '';
      const isMono = /monospace|Consolas/i.test(node.fontFamily);
      const letterSpacing = Number(attrs['letter-spacing'] ?? 0);
      const estW = estimateTextWidth(inner, node.fontSize, isMono, node.fontWeight, letterSpacing);
      const x = Number(attrs.x ?? 0);
      const y = Number(attrs.y ?? 0);
      const anchor = attrs['text-anchor'] || 'start';
      const left = anchor === 'middle' ? x - estW / 2 : anchor === 'end' ? x - estW : x;
      const right = anchor === 'middle' ? x + estW / 2 : anchor === 'end' ? x : x + estW;
      const absLeft = node.ox + left;
      const absRight = node.ox + right;

      if (absLeft < 20 || absRight > svgWidth - 20) {
        errors.push(`${file}: <text> "${decodeXml(inner)}" [${absLeft.toFixed(1)}..${absRight.toFixed(1)}] overflows canvas [20..${svgWidth - 20}]`);
      }

      if (parent && parent.rects.length > 0) {
        const candidates = parent.rects
          .filter((r) => y >= r.ry && y <= r.ry + r.rh && x >= r.rx && x <= r.rx + r.rw)
          .sort((a, b) => a.rw * a.rh - b.rw * b.rh);
        const box = candidates[0] ?? parent.rects[0];
        if (box && box.rw < svgWidth - 10) {
          const padL = left - box.rx;
          const padR = box.rx + box.rw - right;
          if (padL < 6 || padR < 6) {
            errors.push(
              `${file}: <text> "${decodeXml(inner)}" (estW=${estW.toFixed(1)}) overflows/crowds rect[${box.rx}..${box.rx + box.rw}] (padL=${padL.toFixed(1)}, padR=${padR.toFixed(1)})`,
            );
          }
        }
      }
    }

    if (!selfClose && !full.endsWith('/>')) {
      stack.push(node);
    }
  }
}

if (errors.length > 0) {
  console.error(`SVG layout check failed (${errors.length} issue(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`SVG layout check passed across ${svgFiles.length} diagram(s): 0 text or container overflows.`);
