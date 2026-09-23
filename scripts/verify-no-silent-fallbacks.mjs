#!/usr/bin/env node
/**
 * No silent fallbacks in render-critical code
 * (docs/engineering/no-silent-fallbacks.md).
 *
 * Missing, failed or unsupported data must fail a render, or be substituted
 * only when the job input asks for it and the manifest records it. This check
 * scans the renderer, the render package and the CARLA adapter for the
 * constructs that silently swallow a failure or invent a value:
 *
 * - Rust: `unwrap_or*`, `.ok()`, `let _ =`, `Err(_) =>`, `else { continue }`;
 * - TypeScript: `?? <literal>`, `|| <literal>`, an empty `catch {}`,
 *   `.catch(() => ...)`;
 * - Python: `except ...: pass`, `.get(key, default)`, `or <literal>`;
 * - in every language, the words fallback, placeholder and proxy.
 *
 * A hit passes when either:
 * - the line, or the line above it, carries `fallback-ok: <reason>` (a
 *   justification a reviewer reads in the diff); or
 * - it is counted in the burn-down baseline
 *   (`scripts/no-silent-fallbacks.baseline.json`: per file and rule, the
 *   number of pre-policy hits, with a justification).
 *
 * Counts must match exactly. A new unjustified hit fails. So does a count
 * below the baseline: lower the entry as you remove fallbacks, so the list
 * cannot go stale. `--write-baseline` rewrites the counts. It keeps the
 * justifications of existing entries and refuses to add a file or raise a
 * count unless `--reason "<justification>"` is given.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASELINE = join(ROOT, 'scripts/no-silent-fallbacks.baseline.json');
const SCAN = [
  'renderer/render-core/src',
  'renderer/sensors/src',
  'renderer/service/src',
  'renderer/ffi/src',
  'packages/render/src',
  'adapters/carla-exec/simforge_oss_carla_exec',
];
const MARKER = /fallback-ok:\s*\S/u;

const WORDS = { id: 'fallback-word', re: /\b(?:fall-?backs?|placeholders?|prox(?:y|ies))\b/iu };
const RULES = {
  rs: [
    { id: 'rs-unwrap-or', re: /\.unwrap_or(?:_default|_else)?\s*\(/u },
    { id: 'rs-ok-discard', re: /\.ok\(\)\s*(?:[;?)]|$|\.(?:and_then|map|flatten|unwrap_or|filter))/u },
    { id: 'rs-let-underscore', re: /\blet\s+_\s*=/u },
    { id: 'rs-err-wildcard', re: /\bErr\(\s*_\s*\)\s*=>/u },
    { id: 'rs-else-continue', re: /\belse\s*\{\s*continue\s*;?\s*\}/u },
    WORDS,
  ],
  ts: [
    { id: 'ts-nullish-literal', re: /\?\?\s*(?:-?\d|['"`]|true\b|false\b|null\b|undefined\b|\[\s*\]|\{\s*\})/u },
    { id: 'ts-or-literal', re: /\|\|\s*(?:-?\d|['"`]|true\b|false\b|\[\s*\]|\{\s*\})/u },
    { id: 'ts-empty-catch', re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/u },
    { id: 'ts-promise-catch', re: /\.catch\(\s*(?:\(\s*\)|\w+|\(\s*\w*\s*\))\s*=>/u },
    WORDS,
  ],
  py: [
    { id: 'py-except-pass', re: /^\s*except\b[^:]*:\s*(?:pass\b|$)/u, next: /^\s*pass\b/u },
    { id: 'py-get-default', re: /\.get\(\s*[^,()]+,\s*[^)]/u },
    { id: 'py-or-literal', re: /\bor\s+(?:-?\d|['"]|\[\s*\]|\{\s*\}|\(\s*\)|True\b|False\b|None\b)/u },
    WORDS,
  ],
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__pycache__' || name === 'tests' || name === 'vendor') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function language(path) {
  if (path.endsWith('.rs')) return 'rs';
  if (/\.(?:ts|mts|tsx)$/u.test(path) && !/\.(?:test|spec)\.tsx?$/u.test(path) && !path.endsWith('.d.ts')) return 'ts';
  if (path.endsWith('.py') && !/(?:^|\/)test_[^/]*\.py$/u.test(path)) return 'py';
  return undefined;
}

/** Lines to scan: Rust stops at the file's trailing `#[cfg(test)] mod`. */
function scannable(lang, text) {
  const lines = text.split('\n');
  if (lang !== 'rs') return lines;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (/^#\[cfg\(test\)\]\s*$/u.test(lines[index]) && /^mod\s+\w+/u.test(lines[index + 1])) return lines.slice(0, index);
  }
  return lines;
}

function isComment(lang, line) {
  const trimmed = line.trim();
  return lang === 'py' ? trimmed.startsWith('#') : /^(?:\/\/|\*|\/\*)/u.test(trimmed);
}

export function scan(root = ROOT) {
  const counts = new Map();
  const hits = [];
  for (const base of SCAN) {
    for (const path of walk(join(root, base))) {
      const lang = language(path);
      if (!lang) continue;
      const file = relative(root, path);
      const lines = scannable(lang, readFileSync(path, 'utf8'));
      lines.forEach((line, index) => {
        for (const rule of RULES[lang]) {
          // Comments may say "fallback" when explaining its absence; code rules only.
          if (rule === WORDS ? false : isComment(lang, line)) continue;
          if (!rule.re.test(line)) continue;
          if (rule.next && !/pass\b/u.test(line) && !rule.next.test(lines[index + 1] ?? '')) continue;
          if (MARKER.test(line) || MARKER.test(lines[index - 1] ?? '')) continue;
          const key = `${file}\u0000${rule.id}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          hits.push({ file, line: index + 1, rule: rule.id, text: line.trim() });
        }
      });
    }
  }
  return { counts, hits };
}

function readBaseline(path = BASELINE) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const entries = new Map();
  for (const entry of document.entries) {
    if (typeof entry.justification !== 'string' || entry.justification.trim().length < 12) {
      throw new Error(`baseline entry ${entry.file} ${entry.rule} lacks a justification`);
    }
    entries.set(`${entry.file}\u0000${entry.rule}`, entry);
  }
  return { document, entries };
}

/** Problems of the tree at `root` against `baseline` (empty when clean). */
export function check(root = ROOT, baseline = BASELINE) {
  const { counts, hits } = scan(root);
  const { entries } = readBaseline(baseline);
  return { failures: compare(counts, hits, entries), hits };
}

function compare(counts, hits, entries) {
  const failures = [];
  for (const [key, count] of counts) {
    const [file, rule] = key.split('\u0000');
    const allowed = entries.get(key)?.count ?? 0;
    if (count > allowed) {
      const lines = hits.filter((hit) => hit.file === file && hit.rule === rule)
        .map((hit) => `    ${hit.file}:${hit.line}  ${hit.text}`);
      failures.push(`${file}: ${count} ${rule} hit(s), baseline allows ${allowed}. Fail the render instead, or justify with a "fallback-ok: <reason>" comment:\n${lines.join('\n')}`);
    }
  }
  for (const [key, entry] of entries) {
    const count = counts.get(key) ?? 0;
    if (count < entry.count) {
      failures.push(`${entry.file}: ${entry.rule} baseline is ${entry.count} but only ${count} remain; lower the entry (node scripts/verify-no-silent-fallbacks.mjs --write-baseline)`);
    }
  }
  return failures;
}

function main(argv) {
  const { counts, hits } = scan();
  const { document, entries } = readBaseline();
  if (argv.includes('--write-baseline')) {
    const reasonIndex = argv.indexOf('--reason');
    const reason = reasonIndex >= 0 ? argv[reasonIndex + 1] : undefined;
    const next = [];
    for (const [key, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
      const [file, rule] = key.split('\u0000');
      const previous = entries.get(key);
      if ((!previous || count > previous.count) && !reason) {
        throw new Error(`${file} ${rule}: ${count} hits exceed the baseline (${previous?.count ?? 0}); pass --reason "<justification>" or justify inline with fallback-ok:`);
      }
      next.push({ file, rule, count, justification: previous && count <= previous.count ? previous.justification : reason });
    }
    writeFileSync(BASELINE, `${JSON.stringify({ ...document, entries: next }, null, 2)}\n`);
    process.stdout.write(`wrote ${next.length} baseline entries\n`);
    return 0;
  }
  const failures = compare(counts, hits, entries);
  if (failures.length > 0) {
    process.stderr.write(`no-silent-fallbacks: ${failures.length} problem(s)\n\n${failures.join('\n\n')}\n\nPolicy: docs/engineering/no-silent-fallbacks.md\n`);
    return 1;
  }
  process.stdout.write(`no-silent-fallbacks: ${hits.length} hits, all within the baseline or justified inline\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
