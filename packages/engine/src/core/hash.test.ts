import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Sha256Stream, sha256Blob, sha256Bytes, sha256BytesAsync } from './hash.js';

/**
 * The digest helpers must work on a PLAINTEXT origin, where `crypto.subtle` is
 * `undefined` because the page is not a secure context. That is not a hypothetical:
 * `crypto.subtle.digest("SHA-256", …)` threw "Cannot read properties of undefined
 * (reading 'digest')" on every LAN and tunnelled origin, which is how Studio is
 * normally reached, and it took down cinematic preview, verified map caching,
 * execution-package verification and the SUMO runtime load.
 *
 * So each case below runs twice: once with the native implementation present and
 * once with it removed, asserting the SAME hex. A reintroduced bare
 * `crypto.subtle.digest` on a browser-reachable path fails the insecure half.
 */
function withoutSubtle<T>(run: () => T): T {
  const original = globalThis.crypto;
  // A crypto object that has everything EXCEPT `subtle`, exactly like an
  // insecure browsing context: `crypto` is present, `crypto.subtle` is absent.
  const insecure = {
    getRandomValues: original.getRandomValues.bind(original),
    randomUUID: original.randomUUID.bind(original),
  } as unknown as Crypto;
  Object.defineProperty(globalThis, 'crypto', { value: insecure, configurable: true, writable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true });
  }
}

afterEach(() => {
  if (globalThis.crypto !== webcrypto) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  }
});

const CASES: ReadonlyArray<readonly [string, Uint8Array]> = [
  ['empty', new Uint8Array(0)],
  ['one byte', new Uint8Array([0x61])],
  // 55/56/64 are the SHA-256 padding boundaries: the length field either fits
  // the final block or forces an extra one. An implementation that gets the
  // tail wrong passes the short cases and fails exactly here.
  ['55 bytes', new Uint8Array(55).fill(0x41)],
  ['56 bytes', new Uint8Array(56).fill(0x42)],
  ['64 bytes', new Uint8Array(64).fill(0x43)],
  ['4 KiB', Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff)],
  ['8 MiB', Uint8Array.from({ length: 8 * 1024 * 1024 }, (_, i) => (i * 7) & 0xff)],
];

describe('sha256 digests match node:crypto with and without SubtleCrypto', () => {
  for (const [label, bytes] of CASES) {
    it(label, async () => {
      const expected = createHash('sha256').update(bytes).digest('hex');
      expect(sha256Bytes(bytes)).toBe(expected);
      expect(await sha256BytesAsync(bytes)).toBe(expected);
      expect(globalThis.crypto.subtle).toBeDefined();
      await withoutSubtle(async () => {
        expect(globalThis.crypto.subtle).toBeUndefined();
        expect(await sha256BytesAsync(bytes)).toBe(expected);
        expect(await sha256Blob(new Blob([bytes as BlobPart]))).toBe(expected);
      });
      expect(await sha256Blob(new Blob([bytes as BlobPart]))).toBe(expected);
    });
  }
});

it('sha256BytesAsync accepts a raw ArrayBuffer on both paths', async () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
  const expected = createHash('sha256').update(bytes).digest('hex');
  expect(await sha256BytesAsync(bytes.buffer)).toBe(expected);
  await withoutSubtle(async () => {
    expect(await sha256BytesAsync(bytes.buffer)).toBe(expected);
  });
});

it('sha256Blob reports monotonic progress up to the total size', async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024).fill(9);
  await withoutSubtle(async () => {
    const seen: number[] = [];
    await sha256Blob(new Blob([bytes as BlobPart]), (hashed, total) => {
      expect(total).toBe(bytes.byteLength);
      seen.push(hashed);
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(bytes.byteLength);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

it('a chunked stream digests the same as one shot', () => {
  const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 3) & 0xff);
  const expected = sha256Bytes(bytes);
  for (const chunk of [1, 7, 64, 65, 1000]) {
    const hasher = new Sha256Stream();
    for (let at = 0; at < bytes.length; at += chunk) hasher.update(bytes.subarray(at, at + chunk));
    expect(hasher.digestHex()).toBe(expected);
  }
});
