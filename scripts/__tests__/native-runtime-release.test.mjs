// The committed pin must stay honest, and a mismatched artifact must be
// refused rather than installed. Both are regressions that unit-level type
// checking cannot see: a stale prebuilt artifact whose binding ABI did not
// match the code is exactly the defect that cost this repository a day.
import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredAbi, builtAbi, agreedAbi } from '../native-runtime/abi.mjs';
import { readReleasePin, resolvePin } from '../native-runtime/fetch-runtime.mjs';
import { SUPPORTED_TARGETS } from '../native-runtime/target-layout.mjs';

const pin = await readReleasePin();

test('the checkout declares one binding ABI on both sides', () => {
  assert.equal(requiredAbi(), builtAbi());
  assert.equal(agreedAbi(), requiredAbi());
});

test('the committed pin describes a release this code can install', () => {
  assert.equal(pin.abi, requiredAbi(), 'the pinned runtime satisfies a different binding ABI than this checkout requires');
  assert.deepEqual(Object.keys(pin.targets).sort(), Object.values(SUPPORTED_TARGETS).sort());
  for (const [target, entry] of Object.entries(pin.targets)) {
    if (entry === null) continue;
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u, `${target} has no sha256`);
    assert.ok(Number.isInteger(entry.sizeBytes) && entry.sizeBytes > 0, `${target} has no length`);
    assert.ok(entry.archive.endsWith(`-${target}.tar.gz`), `${target} pins the archive ${entry.archive}`);
  }
  if (Object.values(pin.targets).some((entry) => entry !== null)) {
    assert.match(pin.revision, /^[a-f0-9]{40}$/u);
    assert.ok(pin.tag?.startsWith('native-runtime-'), `${pin.tag} is not in the native-runtime tag namespace`);
  }
});

test('a pin for another binding ABI is refused before anything is downloaded', () => {
  assert.throws(
    () => resolvePin({ ...pin, abi: pin.abi + 1 }, 'x86_64-unknown-linux-gnu', pin.abi),
    (error) => error.code === 'runtime.abi_mismatch' && /requires ABI/u.test(error.message),
  );
});

test('an unpublished platform is distinguished from an unknown one', () => {
  assert.throws(
    () => resolvePin({ ...pin, targets: { ...pin.targets, 'x86_64-unknown-linux-gnu': null } }, 'x86_64-unknown-linux-gnu', pin.abi),
    (error) => error.code === 'runtime.no_prebuilt_for_target',
  );
  assert.throws(
    () => resolvePin(pin, 'riscv64-unknown-linux-gnu', pin.abi),
    (error) => error.code === 'runtime.unsupported_target',
  );
});

test('a pin that names no release at all asks for a source build', () => {
  assert.throws(
    () => resolvePin({ ...pin, abi: null, tag: null }, 'x86_64-unknown-linux-gnu', requiredAbi()),
    (error) => error.code === 'runtime.no_prebuilt',
  );
});
