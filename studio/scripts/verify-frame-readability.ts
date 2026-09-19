/** Daytime VIEWER frame gate; never an offline/native appearance constraint.
 * --image=<raw-canvas.png> --sky=x,y,width,height[;x,y,width,height] --out=<json>
 * Chromium decodes the actual PNG into Canvas2D; the identical browser-safe
 * analyzer also measures live settled viewers. Sky annotations must identify
 * actual unobstructed sky in this exact frame. Historical screenshots support
 * explicit annotations; live capture verifies them against scene geometry.
 * No assumption that the top of an arbitrary frame is sky is made.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { assertNoBlackGeometry, assertReadableSky, Checks } from './texture-tier-assertions';
import { BLACK_CHANNEL_CEILING, MAX_DARK_PATCH_FRACTION, MAX_SKY_BLACK_FRACTION, MIN_DAY_SKY_LUMINANCE, type FrameReadability, type PixelRect } from './texture-frame-quality';
declare global {
  interface Window {
    __frameReadability: { measureFrameReadability: (rgba: Uint8ClampedArray, width: number, height: number, sky: readonly PixelRect[]) => FrameReadability };
  }
}
const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
assert(args.get('image') && args.get('sky') && args.get('out'), '--image, explicit --sky and --out are required');
const skyRegions = args.get('sky')!.split(';').map(region => {
  const values = region.split(',').map(Number);
  assert(values.length === 4 && values.every(Number.isInteger), `invalid sky annotation ${region}`);
  return { x: values[0]!, y: values[1]!, width: values[2]!, height: values[3]! };
});
const bytes = await readFile(args.get('image')!);
const script = await build({ entryPoints: [join(import.meta.dirname, 'texture-frame-quality.ts')], bundle: true, write: false, platform: 'browser', format: 'iife', globalName: '__frameReadability' });
const browser = await chromium.launch({ headless: true, executablePath: args.get('chromium') ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: script.outputFiles[0]!.text });
  const frame = await page.evaluate(async ({ image, skyRegions }) => {
    const img = new Image(); img.src = image; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(img, 0, 0);
    return window.__frameReadability.measureFrameReadability(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, skyRegions);
  }, { image: `data:image/png;base64,${bytes.toString('base64')}`, skyRegions });
  const checks = new Checks();
  checks.check('settled geometry contains no large near-black patch', { channelCeiling: BLACK_CHANNEL_CEILING, maximumFraction: MAX_DARK_PATCH_FRACTION, ...frame.darkestPatch }, () => assertNoBlackGeometry(frame));
  checks.check('daytime sky is not a black void', { meanLuminance: frame.skyMeanLuminance, minimumObserved: frame.skyMinimumLuminance, requiredMean: MIN_DAY_SKY_LUMINANCE,
    nearBlackFraction: frame.skyBlackFraction, maximumBlackFraction: MAX_SKY_BLACK_FRACTION, sampledPixels: frame.skyPixels }, () => assertReadableSky(frame));
  await writeFile(args.get('out')!, JSON.stringify({ image: args.get('image'), imageSha256: createHash('sha256').update(bytes).digest('hex'),
    decoder: 'Chromium Canvas2D', skyAnnotation: 'explicit historical-frame annotation; not inferred from screen position', skyRegions, frame, checks: checks.results }, null, 2));
  checks.finish();
} finally { await browser.close(); }
