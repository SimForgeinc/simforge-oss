import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canonicalJson, canonicalJsonPretty, canonicalSha256, CANONICAL_JSON_RULE } from '../canonical-json.js';

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'canonical-json', 'vectors.json');

interface Vector { id: string; input: string; canonical: string; sha256: string }
const suite = JSON.parse(readFileSync(VECTORS, 'utf8')) as { rule: string; vectors: Vector[] };

describe('canonical JSON: the shared TS/Rust conformance vectors', () => {
  it('is the rule the vectors were written for', () => {
    expect(suite.rule).toBe(CANONICAL_JSON_RULE);
  });

  it.each(suite.vectors.map((vector) => [vector.id, vector] as const))('%s', (_id, vector) => {
    const value = JSON.parse(vector.input);
    expect(canonicalJson(value)).toBe(vector.canonical);
    expect(canonicalSha256(value)).toBe(vector.sha256);
    // Pretty text differs only in whitespace.
    expect(canonicalJson(JSON.parse(canonicalJsonPretty(value)))).toBe(vector.canonical);
  });
});

describe('canonical JSON rule details', () => {
  it('orders integer-like keys as strings, unlike JSON.stringify of a sorted object', () => {
    const value = { 10: 'a', 9: 'b', x: 'c' };
    expect(canonicalJson(value)).toBe('{"10":"a","9":"b","x":"c"}');
    expect(JSON.stringify(value)).toBe('{"9":"b","10":"a","x":"c"}');
  });

  it('never rounds', () => {
    expect(canonicalJson({ x: 0.1 + 0.2 })).toBe('{"x":0.30000000000000004}');
  });

  it('drops undefined keys, writes undefined array slots as null, rejects non-finite numbers', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(/non-finite/);
  });
});
