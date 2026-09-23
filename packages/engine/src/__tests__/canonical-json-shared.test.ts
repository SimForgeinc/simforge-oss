import { describe, expect, it } from 'vitest';

import { canonicalJson as sharedCanonicalJson } from '@simforge-oss/scenario/canonical-json';

import { canonicalJson, contentHash, sha256 } from '../core/hash.js';

describe('engine canonical JSON is the shared implementation', () => {
  it('re-exports the one function from @simforge-oss/scenario/canonical-json', () => {
    expect(canonicalJson).toBe(sharedCanonicalJson);
  });

  it('contentHash is sha256 of the shared canonical text', () => {
    const value = { b: [1, 0.30000000000000004], a: { 10: 'x', 9: 'y' } };
    expect(contentHash(value)).toBe(sha256('{"a":{"10":"x","9":"y"},"b":[1,0.30000000000000004]}'));
  });
});
