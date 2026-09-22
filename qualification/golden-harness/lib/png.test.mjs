// node --test qualification/golden-harness/lib/png.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

import { decodePng, idPassStats } from './png.mjs';

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/** RGBA PNG from a pixel function, rows alternating filters 0/1/2/3/4. */
function encode(width, height, pixel) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const raw = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), x * 4);
    const filter = y % 5;
    const prev = y > 0 ? rows[y - 1].raw : Buffer.alloc(width * 4);
    const line = Buffer.alloc(width * 4);
    for (let i = 0; i < raw.length; i += 1) {
      const a = i >= 4 ? raw[i - 4] : 0; const b = prev[i]; const c = i >= 4 ? prev[i - 4] : 0;
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      line[i] = (raw[i] - pred) & 0xff;
    }
    rows.push({ raw, bytes: Buffer.concat([Buffer.from([filter]), line]) });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows.map((r) => r.bytes)))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('decodes every filter type exactly', () => {
  const pixel = (x, y) => [(x * 7 + y) & 0xff, (x * y) & 0xff, (x + 3 * y) & 0xff, 255];
  const { width, height, data } = decodePng(encode(13, 11, pixel));
  assert.equal(width, 13); assert.equal(height, 11);
  for (let y = 0; y < 11; y += 1) for (let x = 0; x < 13; x += 1) {
    assert.deepEqual([...data.subarray((y * 13 + x) * 4, (y * 13 + x) * 4 + 4)], pixel(x, y));
  }
});

test('a solid background ID pass is vacuous; real instances are counted', () => {
  const blank = idPassStats(encode(32, 32, () => [0, 0, 0, 255]));
  assert.equal(blank.distinctIds, 0);
  assert.equal(blank.coveredFraction, 0);
  const tiles = idPassStats(encode(32, 32, (x, y) => (x < 16 ? [(x >> 2) + 1, y >> 3, 0, 255] : [0, 0, 0, 255])));
  assert.equal(tiles.distinctIds, 16);
  assert.equal(tiles.coveredFraction, 0.5);
});
