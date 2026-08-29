import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fullClipFrameTimes, renderTrace } from '../src/index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTANCE = path.join(REPO_ROOT, 'fixtures/evidence/golden-yale-bus-stop/instance.json');
const TRACE = path.join(REPO_ROOT, 'fixtures/evidence/golden-yale-bus-stop/trace.json.gz');
const SCRIPT = path.join(REPO_ROOT, 'scripts/render-trace.mjs');
const LEGACY_HASHES = {
  'frames/frame-000.png': 'a15e0f4678325b0577dfc75b123b4e132678f8412181cb83ff10f11b420267d0',
  'frames/frame-000.svg': '257ce36d5c8686d97d31bcc61c41af6cde6220bc08f5261ee0b382d1dd490ea4',
  'frames/frame-001.png': '3888b81e2dbc5659da1e7281d3bd1bb3f0bc6d31a3289cbacf3ece47f3e3d059',
  'frames/frame-001.svg': 'c64af5ebc59fcfe17ae6c3e452840aab42ac4e67dff7aa31bb51fdeb97cb38c5',
  'frames/frame-002.png': 'c75b6d117afdb5d09f199fb40e34a1266de65c422931de7f7735c5441c559358',
  'frames/frame-002.svg': '4309032c2610d0af04dbb6b683b2ab683bdeb43ab58b953e3d3a538c36b2ccae',
  'frames/frame-003.png': '7a2737c5d8310123245ed1e2dd4a71118a28ed2ebeda530ce323ef8e21095db4',
  'frames/frame-003.svg': '16a444f2d15d14690cfad71f6c93953819bfa94b3f9454a62a58e03ff2ba6d1e',
  'trace-render.mp4': '714c75e7f3602c38dbcf52ec48037f080bada214b709e16298bdcb958a40abc4',
  'manifest.json': '7a71c11181aacb58efc25c600032db60998b7c6986bff4e7230e34f80354e341',
};

let tempRoot;
before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'trace-render-test-'));
});
after(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test('full-clip frame plan preserves twenty seconds at requested fps', () => {
  const times = fullClipFrameTimes({ ticks: { t: [0, 20] } }, 12);
  assert.equal(times.length, 240);
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 239 / 12);
});

async function hash(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function artifactHashes(out) {
  return Object.fromEntries(await Promise.all(
    Object.keys(LEGACY_HASHES).map(async (relative) => [relative, await hash(path.join(out, relative))]),
  ));
}

test('thin script wrapper stays byte-identical to the pre-package renderer', async () => {
  const out = path.join(tempRoot, 'wrapper');
  const run = spawnSync(process.execPath, [
    SCRIPT, '--instance', INSTANCE, '--trace', TRACE, '--out', out, '--camera', 'follow-ego', '--fps', '12',
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `${path.join(out, 'manifest.json')}\n`);
  assert.deepEqual(await artifactHashes(out), LEGACY_HASHES);
});

test('two library renders have identical still, video, and manifest hashes', async () => {
  const first = path.join(tempRoot, 'determinism-a');
  const second = path.join(tempRoot, 'determinism-b');
  await renderTrace({ instance: INSTANCE, trace: TRACE, out: first, camera: 'follow-ego', fps: 12 });
  await renderTrace({ instance: INSTANCE, trace: TRACE, out: second, camera: 'follow-ego', fps: 12 });
  assert.deepEqual(await artifactHashes(first), await artifactHashes(second));
});

test('refuses a mismatched instance and trace pair', async () => {
  const mismatched = path.join(tempRoot, 'mismatched.instance.json');
  const instance = JSON.parse(await readFile(INSTANCE, 'utf8'));
  instance.input.seed = `${instance.input.seed}-different`;
  await writeFile(mismatched, `${JSON.stringify(instance)}\n`);
  await assert.rejects(
    renderTrace({ instance: mismatched, trace: TRACE, out: path.join(tempRoot, 'mismatch-out') }),
    /evidence integrity failed: manifest\.inputHash .* != recomputed .*; trace\.header\.inputHash .* != recomputed/,
  );
});
