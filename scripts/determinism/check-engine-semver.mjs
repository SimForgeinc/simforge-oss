#!/usr/bin/env node
/**
 * CI rule: a golden-trace digest change requires an ENGINE_SEM_VER bump.
 *
 *   node scripts/determinism/check-engine-semver.mjs [--base <git-ref>]
 *
 * Compares fixtures/golden-traces/manifest.json and ENGINE_SEM_VER
 * (native/crates/simforge-core/src/lib.rs) at HEAD with the same files at the
 * merge base of <git-ref> (default origin/main). Fails when:
 *
 * - a case present at both points has a different traceSha256 or inputHash
 *   while ENGINE_SEM_VER is unchanged (semantics moved without a bump);
 * - ENGINE_SEM_VER changed but the manifest was not regenerated under it
 *   (manifest.engineSemVer !== ENGINE_SEM_VER);
 * - ENGINE_SEM_VER went down.
 *
 * The golden-trace suite itself (`pnpm golden-traces:verify`, and the
 * native-vs-WASM identity test) proves the manifest matches what this commit's
 * engine produces; this script proves the manifest did not move silently.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = 'fixtures/golden-traces/manifest.json';
const LIB = 'native/crates/simforge-core/src/lib.rs';

const args = process.argv.slice(2);
const baseRef = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main';

function git(...argv) {
  return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function parseSemVer(libRs) {
  const match = /pub const ENGINE_SEM_VER: &str = "(\d+)\.(\d+)\.(\d+)";/.exec(libRs);
  if (!match) throw new Error(`${LIB}: no ENGINE_SEM_VER literal`);
  return { text: `${match[1]}.${match[2]}.${match[3]}`, parts: match.slice(1, 4).map(Number) };
}

function compareSemVer(a, b) {
  for (let i = 0; i < 3; i += 1) if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  return 0;
}

/** Pure rule, exported for tests. Returns a list of violations (empty = pass). */
export function engineSemVerViolations({ base, head }) {
  const violations = [];
  if (head.manifest && head.manifest.engineSemVer !== head.semver.text) {
    violations.push(`ENGINE_SEM_VER is ${head.semver.text} but ${MANIFEST} was produced under ${head.manifest.engineSemVer}; run \`pnpm golden-traces:update\` and commit it.`);
  }
  if (!base) return violations;
  const order = compareSemVer(head.semver, base.semver);
  if (order < 0) violations.push(`ENGINE_SEM_VER went down: ${base.semver.text} → ${head.semver.text}.`);
  if (order === 0 && base.manifest && head.manifest) {
    for (const [id, before] of Object.entries(base.manifest.cases)) {
      const after = head.manifest.cases[id];
      if (!after || after.mapClosureDigest !== before.mapClosureDigest) continue;
      for (const field of ['traceSha256', 'inputHash']) {
        if (after[field] !== before[field]) {
          violations.push(`${id}: ${field} changed (${before[field]} → ${after[field]}) under unchanged ENGINE_SEM_VER ${head.semver.text}; bump it in ${LIB} (docs/engineering/engine-semver.md).`);
        }
      }
    }
  }
  return violations;
}

function readAt(ref, file) {
  try {
    return git('show', `${ref}:${file}`);
  } catch {
    return null;
  }
}

function main() {
  const head = {
    semver: parseSemVer(readFileSync(path.join(ROOT, LIB), 'utf8')),
    manifest: existsSync(path.join(ROOT, MANIFEST)) ? JSON.parse(readFileSync(path.join(ROOT, MANIFEST), 'utf8')) : null,
  };
  let base = null;
  let mergeBase = null;
  try {
    mergeBase = git('merge-base', 'HEAD', baseRef);
  } catch {
    console.warn(`check-engine-semver: cannot resolve ${baseRef}; checking HEAD only.`);
  }
  if (mergeBase) {
    const libAtBase = readAt(mergeBase, LIB);
    const manifestAtBase = readAt(mergeBase, MANIFEST);
    const semverAtBase = libAtBase && /ENGINE_SEM_VER/.test(libAtBase) ? parseSemVer(libAtBase) : null;
    if (semverAtBase) base = { semver: semverAtBase, manifest: manifestAtBase ? JSON.parse(manifestAtBase) : null };
  }
  const violations = engineSemVerViolations({ base, head });
  const summary = { head: head.semver.text, base: base?.semver.text ?? null, mergeBase, cases: head.manifest ? Object.keys(head.manifest.cases).length : 0 };
  if (violations.length > 0) {
    console.error(JSON.stringify({ ...summary, ok: false, violations }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ...summary, ok: true }, null, 2));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
