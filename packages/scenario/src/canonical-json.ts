/**
 * SimForge canonical JSON: the ONE rule every content digest is computed with.
 *
 * TypeScript uses this module and Rust uses `simforge_core::hash::canonical_json`.
 * They implement the same rule, and both run the shared conformance vectors in
 * `fixtures/canonical-json/vectors.json`, so a digest computed in the browser,
 * in Node or in the native core is the same digest. Before this module there
 * were three implementations that disagreed: `serialize.ts` rounded floats to 6
 * decimals, `JSON.stringify` of a key-sorted object reordered integer-like keys,
 * and `render-intent.ts` rejected `undefined` array slots.
 *
 * The rule (RFC 8785 / JCS-compatible for every value SimForge hashes):
 *
 * 1. Object keys are sorted by UTF-16 code unit (`Array.prototype.sort`), at
 *    every depth. Keys whose value is `undefined` are dropped.
 * 2. Array order is preserved. An `undefined` slot is written as `null`.
 * 3. Numbers use ECMAScript `Number.prototype.toString`: the shortest
 *    round-trip digits, fixed notation for exponents in [-6, 21), `-0` as `0`.
 *    Non-finite numbers are rejected. Integers beyond ±2^53 are out of contract.
 * 4. Strings use `JSON.stringify` escaping.
 * 5. No whitespace.
 *
 * **No rounding.** Canonicalization never changes a value. Quantization is a
 * separate, explicit step owned by whoever defines the value's grid: the
 * `.scenario.json` storage grid (`canonical-number.ts`, 6 decimals) and the
 * trace grid (Rust `trace::quantize`). A digest is always
 * `sha256(canonicalJson(alreadyQuantizedValue))`.
 *
 * This module imports only the leaf SHA-256, so browser bundles, the
 * `@simforge-oss/engine/hash` subpath and the Studio server can all reach it
 * (`@simforge-oss/scenario/canonical-json`) without pulling in a schema.
 */

import { Sha256 } from './sha256.js';

/** The version tag of this rule. Bump only together with the Rust writer and the vectors. */
export const CANONICAL_JSON_RULE = 'simforge.canonical-json/v1' as const;

/** Canonical JSON text of `value` (see the module comment for the rule). */
export function canonicalJson(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number': {
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${String(value)}`);
      // `+ 0` turns -0 into 0; JSON.stringify of a finite number is Number#toString.
      return JSON.stringify(value + 0);
    }
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => write(item === undefined ? null : item)).join(',')}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${write(record[key])}`).join(',')}}`;
    }
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not JSON');
    default:
      // `undefined`, functions and symbols never appear in validated documents.
      return 'null';
  }
}

/**
 * Pretty-printed text in canonical key order (two-space indent), for files
 * meant to be diffed. Same ordering and number rules as {@link canonicalJson};
 * only whitespace differs, so `canonicalJson(JSON.parse(pretty)) ===
 * canonicalJson(value)`.
 *
 * `JSON.stringify(sortedObject, null, 2)` is NOT equivalent: JavaScript
 * enumerates integer-like keys ("2", "10") before all others in ascending
 * numeric order, whatever order they were inserted in.
 */
export function canonicalJsonPretty(value: unknown, indent = 2): string {
  return pretty(value, ' '.repeat(indent), '');
}

function pretty(value: unknown, step: string, current: string): string {
  if (value === null || typeof value !== 'object') return write(value);
  const inner = current + step;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => inner + pretty(item === undefined ? null : item, step, inner)).join(',\n')}\n${current}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  if (keys.length === 0) return '{}';
  return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${pretty(record[key], step, inner)}`).join(',\n')}\n${current}}`;
}

/** `sha256(canonicalJson(value))` as lowercase hex: the content id of a JSON value. */
export function canonicalSha256(value: unknown): string {
  return new Sha256().update(new TextEncoder().encode(canonicalJson(value))).digestHex();
}
