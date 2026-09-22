/**
 * Minimal PNG decoder for the golden harness (8-bit gray/RGB/RGBA, no
 * interlace): enough to inspect ID passes without a dependency.
 */
import { inflateSync } from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => buffer[i] === b)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; let interlace = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (bitDepth !== 8 || !channels || interlace !== 0) {
    throw new Error(`unsupported PNG (bitDepth ${bitDepth}, colorType ${colorType}, interlace ${interlace})`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      row[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * What an instance-ID pass actually encodes: distinct non-background RGB24
 * ids and the fraction of pixels they cover. A pass that renders solid
 * background (no ID clones built, wrong layer, cleared target) has 0 ids.
 */
export function idPassStats(buffer) {
  const { width, height, channels, data } = decodePng(buffer);
  if (channels < 3) throw new Error('ID pass must be RGB/RGBA');
  const ids = new Set();
  let covered = 0;
  for (let i = 0; i < width * height; i += 1) {
    const o = i * channels;
    const id = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
    if (id !== 0) { ids.add(id); covered += 1; }
  }
  return { distinctIds: ids.size, coveredFraction: covered / (width * height), width, height };
}
