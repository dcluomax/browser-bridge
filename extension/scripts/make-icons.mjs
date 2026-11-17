// Renders the toolbar icons (a white bridge on a blue rounded square) without image dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'icons');
mkdirSync(out, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundedSquare(u, v) {
  const r = 0.22;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

function inBridge(u, v) {
  const deck = v >= 0.6 && v <= 0.68 && u >= 0.14 && u <= 0.86;
  const dx = u - 0.5;
  const dy = v - 0.66;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const arch = dy <= 0 && dist >= 0.26 && dist <= 0.34;
  const pillar = v >= 0.6 && v <= 0.82 && ((u >= 0.2 && u <= 0.27) || (u >= 0.73 && u <= 0.8));
  return deck || arch || pillar;
}

function render(size) {
  const samples = 4;
  return png(size, (x, y) => {
    let bg = 0;
    let fg = 0;
    for (let sy = 0; sy < samples; sy++) {
      for (let sx = 0; sx < samples; sx++) {
        const u = (x + (sx + 0.5) / samples) / size;
        const v = (y + (sy + 0.5) / samples) / size;
        if (inRoundedSquare(u, v)) {
          bg++;
          if (inBridge(u, v)) fg++;
        }
      }
    }
    const total = samples * samples;
    if (bg === 0) return [0, 0, 0, 0];
    const t = fg / bg;
    const r = Math.round(37 + (255 - 37) * t);
    const g = Math.round(99 + (255 - 99) * t);
    const b = Math.round(235 + (255 - 235) * t);
    return [r, g, b, Math.round((bg / total) * 255)];
  });
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(out, `icon-${size}.png`), render(size));
}
console.log(`icons written to ${out}`);
