import { randomUUID, webcrypto } from 'node:crypto';
import { expect, it } from 'vitest';
import { randomUuid } from './uuid.js';

/**
 * `crypto.randomUUID` is secure-context-only: on the plaintext origin Studio is
 * normally reached on it is `undefined`, so a bare call throws. This helper uses
 * `getRandomValues`, which is not restricted, and must be indistinguishable from
 * the native output.
 */
it('mints version-4 UUIDs in the same shape as crypto.randomUUID', () => {
  const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(randomUUID()).toMatch(shape);
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const id = randomUuid();
    expect(id).toMatch(shape);
    seen.add(id);
  }
  expect(seen.size).toBe(2000);
});

it('works when randomUUID is absent, as in an insecure context', () => {
  const original = globalThis.crypto;
  // `getRandomValues` survives an insecure context; `randomUUID` does not.
  const insecure = { getRandomValues: original.getRandomValues.bind(original) } as unknown as Crypto;
  Object.defineProperty(globalThis, 'crypto', { value: insecure, configurable: true, writable: true });
  try {
    expect(globalThis.crypto.randomUUID).toBeUndefined();
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true });
  }
  expect(globalThis.crypto).toBe(webcrypto);
});
