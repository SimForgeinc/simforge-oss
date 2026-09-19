import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertAuthoredDimensions, assertDimensions, assertNoDuplicateFetches, textureTraffic, trafficBeforeReady } from './texture-tier-assertions';

test('g48 real-browser calibration preserves all 1.387GB of texture traffic and rejects the ratchet', async () => {
  const trace = JSON.parse(await readFile(new URL('./fixtures/g48-texture-trace.json', import.meta.url), 'utf8')) as {
    samples: { readyAt: number }[];
    trace: { n: string; end: number; info?: { url?: string; bytes?: number; w?: number; h?: number } }[];
  };
  const beforeReady = trace.trace.filter(row => row.end <= trace.samples[0]!.readyAt);
  const fetches = beforeReady.filter(row => row.n === 'texture.fetch');
  const decodes = beforeReady.filter(row => row.n === 'texture.transcode');
  assert.equal(fetches.length, 2119);
  assert.equal(new Set(beforeReady.filter(row => row.n === 'texture.load').map(row => row.info!.url)).size, 2119);
  // A /3d/-only filter cannot satisfy this known, independently measured sum.
  assert.equal(fetches.reduce((sum, row) => sum + row.info!.bytes!, 0), 1_387_349_690);
  assert.equal(decodes.reduce((sum, row) => sum + row.info!.bytes!, 0), 22_762_246);
  const histogram: Record<string, number> = {};
  for (const row of decodes) { const key = `${row.info!.w}x${row.info!.h}`; histogram[key] = (histogram[key] ?? 0) + 1; }
  assert.deepEqual(histogram, { '128x128': 2119 });
  assert.throws(() => assertDimensions(histogram, 256), assert.AssertionError);
  assert.throws(() => assertDimensions(histogram, 512), assert.AssertionError);
});

test('texture accounting includes images outside 3d and rejects repeat transfers of a container', () => {
  const requests = [
    { url: 'http://host/maps/x/images/a.ktx2', bytes: 100 },
    { url: 'http://host/maps/x/3d/images/b.ktx2', bytes: 200 },
    { url: 'http://host/maps/x/3d/city.glb', bytes: 900 },
  ];
  assert.deepEqual(textureTraffic(requests), { bytes: 300, requests: 2, distinct: 2, duplicates: [] });
  assertNoDuplicateFetches(requests);
  assert.throws(() => assertNoDuplicateFetches([...requests, requests[0]!]), assert.AssertionError);
});

test('dimension gate accepts genuine nonuniform fidelity but rejects oversize and degenerate allocations', () => {

  assertDimensions({ '128x128': 361, '256x256': 1000, '512x512': 300, '128x64': 2 }, 512);
  assert.throws(() => assertDimensions({ '1024x1024': 1, '256x256': 20 }, 512), assert.AssertionError);
  assert.throws(() => assertDimensions({ '128x128': 2100, '512x512': 1 }, 512), assert.AssertionError);
  assert.throws(() => assertDimensions({}, 256), assert.AssertionError);
});
test('CDP accounting includes partial transfers, separates images/3d, and never double-counts overlap', () => {
  const rows = [
    { url: 'http://host/images/a.ktx2', texture: true, start: 1, finished: 2, bytes: 100, chunks: [{ at: 2, bytes: 90 }] },
    { url: 'http://host/3d/images/b.ktx2', texture: true, start: 1, finished: 4, bytes: 300, chunks: [{ at: 2, bytes: 200 }, { at: 4, bytes: 100 }] },
    { url: 'http://host/3d/city.glb', texture: false, start: 1, finished: 2, bytes: 900, chunks: [] },
    { url: 'http://host/images/later.ktx2', texture: true, start: 4, finished: 5, bytes: 1000, chunks: [] },
  ];
  assert.deepEqual(trafficBeforeReady(rows, 3), { textureBytes: 300, imagesBytes: 300, threeDBytes: 1100, combinedBytes: 1200, textureRequests: 2 });
});

test('authored mip invariant preserves small/NPOT sources and rejects hidden ratchets', () => {
  assertAuthoredDimensions([
    { url: 'small', authoredWidth: 64, authoredHeight: 32, width: 64, height: 32 },
    { url: 'npot', authoredWidth: 992, authoredHeight: 988, width: 248, height: 247 },
    { url: 'allocation', authoredWidth: 1024, authoredHeight: 512, allocatedMaxDimension: 128, width: 128, height: 64 },
  ], 256);
  assert.throws(() => assertAuthoredDimensions([
    { url: 'ratchet', authoredWidth: 1024, authoredHeight: 1024, allocatedMaxDimension: 512, width: 128, height: 128 },
  ], 512), assert.AssertionError);
  assert.throws(() => assertAuthoredDimensions([
    { url: 'upsampled', authoredWidth: 64, authoredHeight: 64, width: 256, height: 256 },
  ], 256), assert.AssertionError);
});
