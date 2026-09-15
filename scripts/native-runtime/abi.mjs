// The one binding ABI number, read from the two places that must agree.
//
// `simforge_bindings_common::ABI_VERSION` is what a built binary carries;
// `@simforge-oss/native-runtime`'s `ABI_VERSION` is what the TypeScript that
// drives it is typed against. They are bumped together (see the doc comments
// on both constants), and every loader already refuses a module whose
// `abiVersion()` differs. Distribution needs the same number *before* the
// bytes are loaded: a published artifact records the ABI it satisfies, and an
// installer refuses one that does not match what this checkout requires.
//
// Read from source rather than imported: these scripts run in CI before any
// workspace package is built, and `native/` is Rust.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TS_CONSTANT = path.join(REPO_ROOT, 'packages/native-runtime/src/shared.ts');
const RUST_CONSTANT = path.join(REPO_ROOT, 'native/crates/simforge-bindings-common/src/lib.rs');

function readNumber(file, pattern) {
  const match = pattern.exec(readFileSync(file, 'utf8'));
  if (!match) throw new Error(`${file} declares no ABI_VERSION; ${pattern} found nothing`);
  return Number.parseInt(match[1], 10);
}

/** The ABI this checkout's TypeScript requires of anything it loads. */
export function requiredAbi() {
  return readNumber(TS_CONSTANT, /^export const ABI_VERSION = (\d+);$/mu);
}

/** The ABI a binary built from this checkout's Rust satisfies. */
export function builtAbi() {
  return readNumber(RUST_CONSTANT, /^pub const ABI_VERSION: u32 = (\d+);$/mu);
}

/**
 * Both, having proved they agree. A checkout whose Rust and TypeScript ABI
 * constants have drifted cannot publish an artifact: whichever number were
 * recorded would be a lie about one half of it.
 */
export function agreedAbi() {
  const required = requiredAbi();
  const built = builtAbi();
  if (required !== built) {
    throw new Error(
      `ABI drift in this checkout: ${TS_CONSTANT} requires ${required}, ${RUST_CONSTANT} builds ${built}. They are bumped together.`,
    );
  }
  return required;
}
