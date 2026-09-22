import assert from 'node:assert/strict';
import { test } from 'node:test';

import { engineSemVerViolations, parseSemVer } from '../determinism/check-engine-semver.mjs';

const lib = (v) => parseSemVer(`pub const ENGINE_SEM_VER: &str = "${v}";`);
const manifest = (engineSemVer, trace, closure = 'c1') => ({
  engineSemVer,
  cases: { a: { mapClosureDigest: closure, inputHash: 'i1', traceSha256: trace } },
});

test('unchanged digests under an unchanged semver pass', () => {
  assert.deepEqual(engineSemVerViolations({
    base: { semver: lib('0.8.0'), manifest: manifest('0.8.0', 't1') },
    head: { semver: lib('0.8.0'), manifest: manifest('0.8.0', 't1') },
  }), []);
});

test('a digest change without a bump fails', () => {
  const violations = engineSemVerViolations({
    base: { semver: lib('0.8.0'), manifest: manifest('0.8.0', 't1') },
    head: { semver: lib('0.8.0'), manifest: manifest('0.8.0', 't2') },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /traceSha256 changed .* under unchanged ENGINE_SEM_VER 0\.8\.0/);
});

test('a digest change with a bump and a regenerated manifest passes', () => {
  assert.deepEqual(engineSemVerViolations({
    base: { semver: lib('0.8.0'), manifest: manifest('0.8.0', 't1') },
    head: { semver: lib('0.9.0'), manifest: manifest('0.9.0', 't2') },
  }), []);
});

test('a bump without regenerating the manifest fails', () => {
  const violations = engineSemVerViolations({
    base: { semver: lib('0.8.0'), manifest: manifest('0.8.0', 't1') },
    head: { semver: lib('0.9.0'), manifest: manifest('0.8.0', 't1') },
  });
  assert.match(violations.join('\n'), /produced under 0\.8\.0/);
});

test('a changed map closure is a fixture change, not an engine change', () => {
  assert.deepEqual(engineSemVerViolations({
    base: { semver: lib('0.8.0'), manifest: manifest('0.8.0', 't1', 'c1') },
    head: { semver: lib('0.8.0'), manifest: manifest('0.8.0', 't2', 'c2') },
  }), []);
});

test('the semver cannot go down', () => {
  const violations = engineSemVerViolations({
    base: { semver: lib('0.9.0'), manifest: manifest('0.9.0', 't1') },
    head: { semver: lib('0.8.0'), manifest: manifest('0.8.0', 't1') },
  });
  assert.match(violations.join('\n'), /went down/);
});
