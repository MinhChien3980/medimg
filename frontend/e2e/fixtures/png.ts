/** Minimal PNG encoder for test images (8-bit greyscale), no dependency beyond node:zlib. */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG of `width` × `height` greyscale pixels given by `value(x, y)` (0..255). */
export function greyPng(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[y * (width + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(value(x, y))));
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A synthetic "chest X-ray": dark lungs in a brighter thorax, with a round opacity. */
export function syntheticChestXray(size = 512): Buffer {
  const c = size / 2;
  return greyPng(size, size, (x, y) => {
    const body = Math.hypot((x - c) / (c * 0.9), (y - c) / (c * 0.95)) < 1 ? 150 : 20;
    const lung = (cx: number) => Math.hypot((x - cx) / (size * 0.16), (y - c) / (size * 0.3)) < 1;
    const opacity = Math.hypot(x - size * 0.68, y - size * 0.42) < size * 0.05;
    if (opacity) return 200;
    return lung(size * 0.33) || lung(size * 0.67) ? 60 : body;
  });
}
