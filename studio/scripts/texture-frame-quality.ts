/** Browser-safe pixel analysis shared by live capture and PNG verification.
 * Calibration at 1600x1000: rejected black bush peaks at59.375% near-black in
 * a32x32 patch; every patch outside that bush is <=32.715%. A50% limit separates
 * the defect from healthy dark foliage. Patch size scales with frame height.
 * This is a DAYTIME VIEWER readability contract, never a native/ML appearance rule.
 */
export const BLACK_CHANNEL_CEILING = 16;
export const MAX_DARK_PATCH_FRACTION = 0.5;
export const MIN_DAY_SKY_LUMINANCE = 32;
export const MAX_SKY_BLACK_FRACTION = 0.05;
export interface PixelRect { x: number; y: number; width: number; height: number }
export interface FrameReadability {
  width: number;
  height: number;
  patchEdge: number;
  skyPixels: number;
  skyMeanLuminance: number;
  skyMinimumLuminance: number;
  skyBlackFraction: number;
  nonSkyPixels: number;
  nonSkyMinimumLuminance: number;
  nonSkyBlackFraction: number;
  darkestPatch: PixelRect & { blackFraction: number; eligiblePixels: number };
}

export function measureFrameReadability(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, skyRegions: readonly PixelRect[]): FrameReadability {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
    throw new Error('Frame dimensions do not match RGBA pixels');
  }
  const sky = new Uint8Array(width * height);
  for (const rect of skyRegions) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
      || rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > width || rect.y + rect.height > height) {
      throw new Error(`Invalid explicit sky region: ${JSON.stringify(rect)}`);
    }
    for (let y = rect.y; y < rect.y + rect.height; y++) sky.fill(1, y * width + rect.x, y * width + rect.x + rect.width);
  }
  const stride = width + 1;
  const blackIntegral = new Uint32Array(stride * (height + 1));
  const eligibleIntegral = new Uint32Array(stride * (height + 1));
  let skyPixels = 0, skyBlack = 0, skyLuminance = 0, skyMinimumLuminance = 255;
  let nonSkyPixels = 0, nonSkyBlack = 0, nonSkyMinimumLuminance = 255;
  for (let y = 0; y < height; y++) {
    let rowBlack = 0, rowEligible = 0;
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x, offset = pixel * 4;
      const r = rgba[offset]!, g = rgba[offset + 1]!, b = rgba[offset + 2]!;
      const luminance = (2126 * r + 7152 * g + 722 * b) / 10000;
      const black = Math.max(r, g, b) <= BLACK_CHANNEL_CEILING;
      if (sky[pixel]) {
        skyPixels++; skyBlack += Number(black); skyLuminance += luminance;
        skyMinimumLuminance = Math.min(skyMinimumLuminance, luminance);
      } else {
        nonSkyPixels++; rowEligible++; nonSkyBlack += Number(black); rowBlack += Number(black);
        nonSkyMinimumLuminance = Math.min(nonSkyMinimumLuminance, luminance);
      }
      const at = (y + 1) * stride + x + 1;
      blackIntegral[at] = blackIntegral[at - stride]! + rowBlack;
      eligibleIntegral[at] = eligibleIntegral[at - stride]! + rowEligible;
    }
  }
  const patchEdge = Math.min(width, height, Math.max(8, Math.round(height * 32 / 1000)));
  const darkestPatch = { x: 0, y: 0, width: patchEdge, height: patchEdge, blackFraction: 0, eligiblePixels: 0 };
  for (let y = 0; y + patchEdge <= height; y++) {
    const top = y * stride, bottom = (y + patchEdge) * stride;
    for (let x = 0; x + patchEdge <= width; x++) {
      const left = x, right = x + patchEdge;
      const eligible = eligibleIntegral[bottom + right]! - eligibleIntegral[top + right]! - eligibleIntegral[bottom + left]! + eligibleIntegral[top + left]!;
      // A mostly-sky window with one dark geometry pixel is not a large region.
      if (eligible < patchEdge * patchEdge * 0.9) continue;
      const count = blackIntegral[bottom + right]! - blackIntegral[top + right]! - blackIntegral[bottom + left]! + blackIntegral[top + left]!;
      const fraction = count / eligible;
      if (fraction > darkestPatch.blackFraction || darkestPatch.eligiblePixels === 0) {
        darkestPatch.x = x; darkestPatch.y = y; darkestPatch.blackFraction = fraction; darkestPatch.eligiblePixels = eligible;
      }
    }
  }
  return { width, height, patchEdge, skyPixels, skyMeanLuminance: skyPixels ? skyLuminance / skyPixels : 0,
    skyMinimumLuminance: skyPixels ? skyMinimumLuminance : 0, skyBlackFraction: skyPixels ? skyBlack / skyPixels : 1,
    nonSkyPixels, nonSkyMinimumLuminance: nonSkyPixels ? nonSkyMinimumLuminance : 0,
    nonSkyBlackFraction: nonSkyPixels ? nonSkyBlack / nonSkyPixels : 0, darkestPatch };
}
