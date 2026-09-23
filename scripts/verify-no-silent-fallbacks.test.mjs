import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check } from './verify-no-silent-fallbacks.mjs';

const BASES = [
  'renderer/render-core/src', 'renderer/sensors/src', 'renderer/service/src', 'renderer/ffi/src',
  'packages/render/src', 'adapters/carla-exec/simforge_oss_carla_exec',
];

function tree(files, entries = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'no-fallbacks-'));
  for (const base of BASES) mkdirSync(path.join(root, base), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(root, file), text);
  const baseline = path.join(root, 'baseline.json');
  writeFileSync(baseline, JSON.stringify({ entries }));
  return check(root, baseline);
}

test('a new unjustified fallback fails in each language', () => {
  const { failures } = tree({
    'renderer/service/src/a.rs': 'let dims = actor.dims.unwrap_or([1.0, 1.0, 1.0]);\n',
    'packages/render/src/b.ts': "const model = catalog.get(id) ?? 'vehicle.sedan';\n",
    'adapters/carla-exec/simforge_oss_carla_exec/c.py': 'try:\n    spawn()\nexcept Exception:\n    pass\n',
  });
  assert.equal(failures.length, 3);
  assert.match(failures.join('\n'), /a\.rs.*rs-unwrap-or/u);
  assert.match(failures.join('\n'), /b\.ts.*ts-nullish-literal/u);
  assert.match(failures.join('\n'), /c\.py.*py-except-pass/u);
});

test('an inline fallback-ok justification or a baseline entry allows a hit', () => {
  const { failures } = tree({
    'renderer/service/src/a.rs': '// fallback-ok: sort key only, never rendered\nlet key = name.unwrap_or("");\n',
    'packages/render/src/b.ts': 'const n = count ?? 0;\n',
  }, [{ file: 'packages/render/src/b.ts', rule: 'ts-nullish-literal', count: 1, justification: 'pre-policy baseline: a count, not render input' }]);
  assert.deepEqual(failures, []);
});

test('a baseline above the remaining hits must be lowered', () => {
  const { failures } = tree({ 'packages/render/src/b.ts': 'const x = 1;\n' },
    [{ file: 'packages/render/src/b.ts', rule: 'ts-nullish-literal', count: 1, justification: 'pre-policy baseline: removed since' }]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /lower the entry/u);
});

test('Rust test modules and TypeScript tests are not scanned', () => {
  const { failures } = tree({
    'renderer/service/src/a.rs': 'fn f() {}\n#[cfg(test)]\nmod tests {\n    let x = y.unwrap_or(0);\n}\n',
    'packages/render/src/b.test.ts': "const x = y ?? 'z';\n",
  });
  assert.deepEqual(failures, []);
});

test('a baseline entry needs a justification', () => {
  assert.throws(() => tree({}, [{ file: 'x', rule: 'y', count: 1, justification: '' }]), /lacks a justification/u);
});
