import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDate(epoch) {
  const seconds = epoch ?? process.env.SOURCE_DATE_EPOCH ?? '315532800';
  if (!/^\d+$/.test(String(seconds))) throw new Error('SOURCE_DATE_EPOCH must contain UTC epoch seconds.');
  const date = new Date(Number(seconds) * 1000);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 1980 || year > 2107) {
    throw new Error('ZIP timestamps must be between 1980 and 2107.');
  }
  return {
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
  };
}

// Stored ZIP entries avoid platform-dependent compressors and work in Firefox XPI files.
export function zipBytes(entries, epoch) {
  const stamp = zipDate(epoch);
  const local = [];
  const central = [];
  const names = new Set();
  let offset = 0;
  if (entries.length > 65535) throw new Error('ZIP64 archives are not supported.');
  for (const [path, value] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe ZIP member: ${path}`);
    }
    if (names.has(path.toLowerCase())) throw new Error(`Duplicate ZIP member: ${path}`);
    names.add(path.toLowerCase());
    const name = Buffer.from(path, 'utf8');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (data.length > 0xffffffff || name.length > 65535 || offset > 0xffffffff) {
      throw new Error('ZIP64 archives are not supported.');
    }
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(stamp.time, 12);
    directory.writeUInt16LE(stamp.date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralSize = central.reduce((total, entry) => total + entry.length, 0);
  if (offset > 0xffffffff || centralSize > 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export function writeZipFromDirectory(source, destination, epoch) {
  const root = resolve(source);
  const entries = [];
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Archive inputs cannot be links: ${path}`);
      const member = prefix ? `${prefix}/${name}` : name;
      if (info.isDirectory()) visit(path, member);
      else if (info.isFile()) entries.push([member, readFileSync(path)]);
      else throw new Error(`Archive input is not a regular file: ${path}`);
    }
  }
  visit(root);
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  writeFileSync(destination, zipBytes(entries, epoch));
}
