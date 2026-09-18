/**
 * Deterministic content hashing for trace headers, replay keys and every
 * content digest the browser computes.
 *
 * ONE SHA-256 lives here. It is pure TS rather than `node:crypto` /
 * `SubtleCrypto` so the same code runs in the editor preview and in headless
 * Node, synchronously, with no platform branch that could silently produce a
 * different digest — and so a digest check can never be skipped for want of a
 * platform primitive.
 *
 * `SubtleCrypto` is not a substitute. `crypto.subtle` exists only in a *secure
 * context*, so on a plain-HTTP origin that is not `localhost` — any LAN address
 * or tunnelled host, which is how Studio is normally reached — it is
 * `undefined` and `crypto.subtle.digest(...)` throws "Cannot read properties of
 * undefined (reading 'digest')". It also needs the whole object resident in
 * memory, which rules it out for the multi-gigabyte clip bundles the upload
 * path accepts. It *is* faster when present, so `sha256BytesAsync` and
 * `sha256Blob` use it opportunistically and fall back here otherwise; every
 * caller that needs a digest in the browser goes through one of those two and
 * never touches `crypto.subtle` directly.
 *
 * This module is a leaf: it imports nothing. That is what lets the browser-safe
 * `@simforge-oss/studio-ui/evaluation` barrel reach it on the
 * `@simforge-oss/engine/hash` subpath without pulling the engine in.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Streaming SHA-256. Feed it `update`, read `digestHex` once.
 *
 * Streaming rather than one-shot so a multi-gigabyte object can be hashed a
 * chunk at a time, and so the one-shot form below needs no padded copy of its
 * input: only the 64-byte tail block is ever materialised.
 */
export class Sha256Stream {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private blockLength = 0;
  private totalBytes = 0;

  update(chunk: Uint8Array): this {
    this.totalBytes += chunk.length;
    let offset = 0;
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, chunk.length);
      this.block.set(chunk.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength < 64) return this;
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
    return this;
  }

  digestHex(): string {
    const bitLength = this.totalBytes * 8;
    const tail = new Uint8Array(this.blockLength < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.blockLength), 0);
    tail[this.blockLength] = 0x80;
    // Length is 64-bit big-endian; a JS number holds the high word exactly for
    // any object below 2^53 bits, far beyond anything that can be hashed here.
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(tail.length - 4, bitLength >>> 0, false);
    for (let offset = 0; offset < tail.length; offset += 64) this.compress(tail, offset);

    let hex = '';
    for (let i = 0; i < 8; i++) hex += this.state[i]!.toString(16).padStart(8, '0');
    return hex;
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const w = this.schedule;
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      w[i] = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const p = w[i - 15]!;
      const q = w[i - 2]!;
      const s0 = ((p >>> 7) | (p << 25)) ^ ((p >>> 18) | (p << 14)) ^ (p >>> 3);
      const s1 = ((q >>> 17) | (q << 15)) ^ ((q >>> 19) | (q << 13)) ^ (q >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    const s = this.state;
    let a = s[0]!;
    let b = s[1]!;
    let c = s[2]!;
    let d = s[3]!;
    let e = s[4]!;
    let f = s[5]!;
    let g = s[6]!;
    let h = s[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    s[0] = (s[0]! + a) >>> 0;
    s[1] = (s[1]! + b) >>> 0;
    s[2] = (s[2]! + c) >>> 0;
    s[3] = (s[3]! + d) >>> 0;
    s[4] = (s[4]! + e) >>> 0;
    s[5] = (s[5]! + f) >>> 0;
    s[6] = (s[6]! + g) >>> 0;
    s[7] = (s[7]! + h) >>> 0;
  }
}

/** SHA-256 of a byte array, lowercase hex. Synchronous, no platform branch. */
export function sha256Bytes(input: Uint8Array): string {
  return new Sha256Stream().update(input).digestHex();
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}

function hex(digest: ArrayBuffer): string {
  let out = '';
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * THE browser digest entry point for bytes already in memory: native
 * `SubtleCrypto` when the page is a secure context, this module's SHA-256
 * otherwise. Identical hex either way.
 *
 * Browser-reachable code must call this instead of `crypto.subtle.digest`,
 * which is absent on a plain-HTTP origin.
 */
export async function sha256BytesAsync(input: Uint8Array | ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return sha256Bytes(input instanceof Uint8Array ? input : new Uint8Array(input));
  return hex(await subtle.digest('SHA-256', input as BufferSource));
}

/** Native digest stops being a good idea somewhere around a few hundred MB. */
const NATIVE_DIGEST_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * THE browser digest entry point for a `Blob`/`File`, reporting bytes hashed so
 * a caller can show progress on a large object before any upload traffic
 * starts. Streams the bytes whenever the native path is unavailable or the
 * object is too large to hold resident.
 *
 * The digest is not decoration: an upload grant is issued for exactly these
 * bytes, and the server rejects a completed upload whose stored digest differs.
 */
export async function sha256Blob(
  blob: Blob,
  onProgress?: (bytesHashed: number, bytesTotal: number) => void,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && blob.size <= NATIVE_DIGEST_LIMIT_BYTES) {
    const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
    onProgress?.(blob.size, blob.size);
    return hex(digest);
  }

  const hasher = new Sha256Stream();
  let hashed = 0;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
    hasher.update(chunk);
    hashed += chunk.length;
    onProgress?.(hashed, blob.size);
  }
  return hasher.digestHex();
}

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` dropped,
 * non-finite numbers rejected. Two structurally equal inputs always serialise
 * to the same string, so `sha256(canonicalJson(x))` is a stable content id.
 */
export function canonicalJson(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error(`canonicalJson: non-finite number ${String(n)}`);
    return JSON.stringify(n + 0);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => write(v === undefined ? null : v)).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${write(obj[k])}`).join(',')}}`;
  }
  // `undefined`, functions and symbols never appear in validated input.
  return 'null';
}

/** Content id for a validated `SimScenarioInput` (or any JSON value). */
export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
