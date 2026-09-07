/**
 * Incremental SHA-256 over a browser `File`.
 *
 * `crypto.subtle.digest` needs the whole object resident in memory, which is
 * not an option for the multi-gigabyte clip bundles the upload path accepts, so
 * large inputs are hashed a chunk at a time off the file's stream. Small
 * objects still take the native path because it is markedly faster.
 *
 * The digest is not decoration: the storage grant is issued for exactly these
 * bytes, and the server rejects a completed upload whose stored digest differs.
 */

/** Native digest stops being a good idea somewhere around a few hundred MB. */
const NATIVE_DIGEST_LIMIT_BYTES = 64 * 1024 * 1024;

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Streaming SHA-256. Feed it `update`, read `digestHex` once. */
export class Sha256Stream {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private blockLength = 0;
  private totalBytes = 0;

  update(chunk: Uint8Array): void {
    this.totalBytes += chunk.length;
    let offset = 0;
    if (this.blockLength > 0) {
      const need = 64 - this.blockLength;
      const take = Math.min(need, chunk.length);
      this.block.set(chunk.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength < 64) return;
      this.compress(this.block, 0);
      this.blockLength = 0;
    }
    while (offset + 64 <= chunk.length) {
      this.compress(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.length) {
      this.block.set(chunk.subarray(offset), 0);
      this.blockLength = chunk.length - offset;
    }
  }

  digestHex(): string {
    const bitLength = this.totalBytes * 8;
    const tail = new Uint8Array(this.blockLength < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.blockLength), 0);
    tail[this.blockLength] = 0x80;
    // Length is 64-bit big-endian; JS numbers cover the high word exactly for
    // any object smaller than 2^53 bits, which is far beyond the size cap.
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(tail.length - 4, bitLength >>> 0);
    for (let offset = 0; offset < tail.length; offset += 64) this.compress(tail, offset);

    let hex = "";
    for (let index = 0; index < 8; index += 1) {
      hex += this.state[index].toString(16).padStart(8, "0");
    }
    return hex;
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const w = this.schedule;
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      w[index] =
        ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const p = w[index - 15];
      const q = w[index - 2];
      const s0 = ((p >>> 7) | (p << 25)) ^ ((p >>> 18) | (p << 14)) ^ (p >>> 3);
      const s1 = ((q >>> 17) | (q << 15)) ^ ((q >>> 19) | (q << 13)) ^ (q >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + ROUND_CONSTANTS[index] + w[index]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const s = this.state;
    s[0] = (s[0] + a) >>> 0;
    s[1] = (s[1] + b) >>> 0;
    s[2] = (s[2] + c) >>> 0;
    s[3] = (s[3] + d) >>> 0;
    s[4] = (s[4] + e) >>> 0;
    s[5] = (s[5] + f) >>> 0;
    s[6] = (s[6] + g) >>> 0;
    s[7] = (s[7] + h) >>> 0;
  }
}

/**
 * Lowercase hex SHA-256 of a whole file, reporting bytes hashed so the caller
 * can show progress on a large object before any upload traffic starts.
 */
export async function hashFileSha256(
  file: Blob,
  onProgress?: (bytesHashed: number, bytesTotal: number) => void,
): Promise<string> {
  if (file.size <= NATIVE_DIGEST_LIMIT_BYTES && globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    onProgress?.(file.size, file.size);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  const hasher = new Sha256Stream();
  let hashed = 0;
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
    hasher.update(chunk);
    hashed += chunk.length;
    onProgress?.(hashed, file.size);
  }
  return hasher.digestHex();
}
