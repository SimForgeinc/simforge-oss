import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertNoBlackGeometry, assertReadableSky } from './texture-tier-assertions';
import { measureFrameReadability } from './texture-frame-quality';

function grayFrame(width: number, height: number) {
  const rgba = new Uint8Array(width * height * 4).fill(120);
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
  return rgba;
}

test('real black bush fails while the darkest healthy foliage patch passes', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/frame-readability.json', import.meta.url), 'utf8')) as {
    patches: { label: string; rgbaBase64: string; width: number; height: number; nearBlackFractionAt16: number }[];
  };
  const bad = fixture.patches.find(patch => patch.label === 'rejectedBlackBush');
  const healthy = fixture.patches.find(patch => patch.label === 'healthyDarkFoliage');
  assert(bad && healthy);
  for (const patch of [bad, healthy]) {
    // Preserve the capture's1000px height so the calibrated patch remains32px.
    const width = 200, height = 1000, rgba = grayFrame(width, height);
    const captured = Buffer.from(patch.rgbaBase64, 'base64');
    for (let y = 0; y < patch.height; y++) rgba.set(captured.subarray(y * patch.width * 4, (y + 1) * patch.width * 4), ((200 + y) * width + 64) * 4);
    const frame = measureFrameReadability(rgba, width, height, [{ x: 0, y: 0, width, height: 32 }]);
    assert.equal(frame.darkestPatch.blackFraction, patch.nearBlackFractionAt16);
    assertReadableSky(frame);
    if (patch === bad) assert.throws(() => assertNoBlackGeometry(frame), assert.AssertionError);
    else assertNoBlackGeometry(frame);
  }
});

test('dark regions at the bottom-right edge are detected at both frame resolutions', () => {
  for (const height of [1000, 500]) {
    const width = height * 1.6, edge = height * 32 / 1000, rgba = grayFrame(width, height);
    for (let y = height - edge; y < height; y++) for (let x = width - edge; x < width; x++) {
      const at = (y * width + x) * 4; rgba[at] = rgba[at + 1] = rgba[at + 2] = 0;
    }
    const frame = measureFrameReadability(rgba, width, height, [{ x: 0, y: 0, width, height: edge }]);
    assert.deepEqual(frame.darkestPatch, { x: width - edge, y: height - edge, width: edge, height: edge, blackFraction: 1, eligiblePixels: edge * edge });
    assert.throws(() => assertNoBlackGeometry(frame), assert.AssertionError);
  }
});

test('the calibrated50% boundary fails, and pixels above the16-channel ceiling are not black', () => {
  const width = 200, height = 1000, rgba = grayFrame(width, height);
  for (let y = 200; y < 232; y++) for (let x = 50; x < 66; x++) {
    const at = (y * width + x) * 4; rgba[at] = rgba[at + 1] = rgba[at + 2] = 16;
  }
  const sky = [{ x: 0, y: 0, width, height: 32 }];
  const atBoundary = measureFrameReadability(rgba, width, height, sky);
  assert.equal(atBoundary.darkestPatch.blackFraction, 0.5);
  assert.throws(() => assertNoBlackGeometry(atBoundary), assert.AssertionError);
  rgba[(200 * width + 50) * 4] = 17;
  const below = measureFrameReadability(rgba, width, height, sky);
  assert.equal(below.darkestPatch.blackFraction, 511 / 1024);
  assertNoBlackGeometry(below);
});

test('explicit overlapping sky regions exclude sky from geometry but cannot conceal a black sky', () => {
  const width = 200, height = 1000, rgba = grayFrame(width, height);
  for (let y = 0; y < 100; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4; rgba[at] = rgba[at + 1] = rgba[at + 2] = 0;
  }
  const frame = measureFrameReadability(rgba, width, height, [{ x: 0, y: 0, width: 120, height: 100 }, { x: 80, y: 0, width: 120, height: 100 }]);
  assert.equal(frame.skyPixels, 20000);
  assertNoBlackGeometry(frame);
  assert.throws(() => assertReadableSky(frame), assert.AssertionError);
  assert.throws(() => assertReadableSky(measureFrameReadability(rgba, width, height, [])), assert.AssertionError);
});

test('the rejected Low charcoal sky fails the luminance floor even without near-black pixels', () => {
  const width = 200, height = 1000, rgba = grayFrame(width, height);
  const sky = [{ x: 0, y: 0, width, height: 100 }];
  for (let y = 0; y < 100; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4; rgba[at] = 20; rgba[at + 1] = 24; rgba[at + 2] = 30;
  }
  const rejected = measureFrameReadability(rgba, width, height, sky);
  assert.equal(rejected.skyBlackFraction, 0);
  assert(Math.abs(rejected.skyMeanLuminance - 23.5828) < 1e-8);
  assert.throws(() => assertReadableSky(rejected), assert.AssertionError);
  for (let y = 0; y < 100; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4; rgba[at] = rgba[at + 1] = rgba[at + 2] = 32;
  }
  assertReadableSky(measureFrameReadability(rgba, width, height, sky));
});
