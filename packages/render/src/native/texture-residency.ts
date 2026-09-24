import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NativeTextureMemberSource } from './texture-profile.js';

/**
 * Per-job static mip residency (docs/engineering/texture-residency.md).
 *
 * The map's texture density derivative (`derived/texture-density/manifest.json`,
 * schema `simforge.map-texture-density.v1`, built at ingest by
 * `@simforge-oss/map-pipeline` `buildTextureDensity`) says, for every KTX2
 * image, where it is drawn and the lowest texel density any of its
 * triangles maps it at. A job knows every camera position it will render
 * from before the service starts, so the finest mip level an image can be
 * sampled at over the whole job is bounded by
 *
 *   texels per pixel >= density * distance / focalCorner
 *   finest level      = floor(log2(texels per pixel) + NATIVE_MIN_MIP_BIAS)
 *
 * with `distance` the closest horizontal approach of any camera to the use's
 * box (at least the near plane) and `focalCorner` the camera's focal length
 * in pixels over cos^2 of its corner ray angle (the smallest angle a pixel
 * subtends). Every factor is a bound in the conservative direction, so the
 * levels a plan drops are levels no rendered pixel samples: the service
 * renders the same pixels while uploading a fraction of the textures.
 */
export const NATIVE_TEXTURE_DENSITY_MANIFEST = 'derived/texture-density/manifest.json';
const TEXTURE_DENSITY_SCHEMA = 'simforge.map-texture-density.v1';
export const NATIVE_TEXTURE_RESIDENCY_SCHEMA = 'simforge.texture-residency-plan.v1';
/**
 * The most negative mip bias any view samples with: TAA's `MipBias(-1)`.
 * Applied to every camera (a job's anti-aliasing is resolved by the
 * service), it costs at most one level.
 */
export const NATIVE_MIN_MIP_BIAS = -1;

type DensityUse = readonly [number, number, number, number, number];
export interface NativeTextureDensityImage {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly uses: readonly DensityUse[];
}

export interface NativeTextureDensityPlan {
  readonly manifestSha256: string;
  readonly buildKey: string;
  readonly images: readonly NativeTextureDensityImage[];
}

/**
 * `undefined` when the map carries no derivative (every texture keeps its
 * full chain; the evidence says so). A derivative bound to another master
 * or malformed is an error, never a silent full-residency render.
 */
export async function planNativeTextureDensity(source: NativeTextureMemberSource): Promise<NativeTextureDensityPlan | undefined> {
  const manifestSha256 = source.sha256(NATIVE_TEXTURE_DENSITY_MANIFEST);
  if (!manifestSha256) return undefined;
  let manifest: { schema?: unknown; buildKey?: unknown; images?: unknown; source?: { master?: { path?: unknown; sha256?: unknown } } };
  try {
    manifest = JSON.parse(await source.readText(NATIVE_TEXTURE_DENSITY_MANIFEST)) as typeof manifest;
  } catch (error) {
    throw new Error(`native_texture_density_invalid: ${NATIVE_TEXTURE_DENSITY_MANIFEST} is not JSON (${(error as Error).message})`);
  }
  if (manifest.schema !== TEXTURE_DENSITY_SCHEMA) throw new Error(`native_texture_density_invalid: schema ${String(manifest.schema)} (${TEXTURE_DENSITY_SCHEMA})`);
  if (typeof manifest.buildKey !== 'string') throw new Error('native_texture_density_invalid: no buildKey');
  const master = manifest.source?.master;
  if (master?.path !== 'master.gltf' || master.sha256 !== source.sha256('master.gltf')) {
    throw new Error('native_texture_density_master_mismatch: the derivative was built from another master.gltf');
  }
  if (!Array.isArray(manifest.images)) throw new Error('native_texture_density_invalid: images');
  const seen = new Set<string>();
  for (const image of manifest.images as NativeTextureDensityImage[]) {
    if (typeof image?.uri !== 'string' || seen.has(image.uri) || !Number.isInteger(image.width) || !Number.isInteger(image.height) || !Array.isArray(image.uses)) {
      throw new Error(`native_texture_density_invalid: image ${String(image?.uri)}`);
    }
    seen.add(image.uri);
    for (const use of image.uses) {
      if (!Array.isArray(use) || use.length !== 5 || !use.every((value) => typeof value === 'number' && Number.isFinite(value)) || use[4] < 0) {
        throw new Error(`native_texture_density_invalid: a use of ${image.uri}`);
      }
    }
  }
  return { manifestSha256, buildKey: manifest.buildKey, images: manifest.images as NativeTextureDensityImage[] };
}

/** A rendered camera: its eye (scene frame, metres) and its projection. */
export interface NativeResidencyCamera {
  readonly eye: readonly [number, number, number];
  readonly width: number;
  readonly height: number;
  /** Vertical field of view, degrees. */
  readonly fovDeg: number;
}

/** Focal length in pixels over cos^2 of the corner ray angle. */
export function nativeCornerFocalPx(camera: Pick<NativeResidencyCamera, 'width' | 'height' | 'fovDeg'>): number {
  const tanY = Math.tan((camera.fovDeg * Math.PI) / 360);
  const tanX = (tanY * camera.width) / camera.height;
  const focal = camera.height / 2 / tanY;
  return focal * (1 + tanX * tanX + tanY * tanY);
}

/**
 * The finest mip level each image of `images` can be sampled at by any of
 * `frames`' cameras (0: the full chain; the plan clamps it to the staged
 * file's chain). Pure and deterministic: a function
 * of the derivative, the camera poses and the near plane.
 */
export function nativeTextureResidencyLevels(
  images: readonly NativeTextureDensityImage[],
  frames: readonly (readonly NativeResidencyCamera[])[],
  nearM: number,
): Map<string, number> {
  if (!(nearM > 0)) throw new Error(`native_texture_residency_invalid: near plane ${nearM}`);
  // Distinct horizontal positions per corner focal length (cm grid).
  const groups = new Map<number, Map<string, [number, number]>>();
  for (const cameras of frames) {
    for (const camera of cameras) {
      const focal = nativeCornerFocalPx(camera);
      if (!(focal > 0) || !Number.isFinite(focal)) throw new Error(`native_texture_residency_invalid: camera ${camera.width}x${camera.height} fov ${camera.fovDeg}`);
      let positions = groups.get(focal);
      if (!positions) groups.set(focal, positions = new Map());
      const x = Math.round(camera.eye[0] * 100) / 100, z = Math.round(camera.eye[2] * 100) / 100;
      positions.set(`${x},${z}`, [x, z]);
    }
  }
  const rigs = [...groups].map(([focal, positions]) => {
    const flat = new Float64Array(positions.size * 2);
    let i = 0;
    for (const [x, z] of positions.values()) { flat[i++] = x; flat[i++] = z; }
    return { focal, positions: flat };
  });
  const levels = new Map<string, number>();
  for (const image of images) {
    // Lowest texels-per-pixel of any use seen from any camera.
    let lowest = Infinity;
    for (const [minX, minZ, maxX, maxZ, density] of image.uses) {
      if (density === 0) { lowest = 0; break; }
      for (const { focal, positions } of rigs) {
        let nearest = Infinity;
        for (let i = 0; i < positions.length; i += 2) {
          const dx = Math.max(0, minX - positions[i]!, positions[i]! - maxX);
          const dz = Math.max(0, minZ - positions[i + 1]!, positions[i + 1]! - maxZ);
          const d = dx * dx + dz * dz;
          if (d < nearest) nearest = d;
        }
        const texelsPerPixel = (density * Math.max(nearM, Math.sqrt(nearest))) / focal;
        if (texelsPerPixel < lowest) lowest = texelsPerPixel;
      }
      if (lowest === 0) break;
    }
    if (!Number.isFinite(lowest)) continue; // no camera: nothing to bound (no frames)
    const finest = lowest > 0 ? Math.floor(Math.log2(lowest) + NATIVE_MIN_MIP_BIAS) : 0;
    levels.set(image.uri, Math.max(0, finest));
  }
  return levels;
}

export interface NativeTextureResidency {
  /** The service's plan (`simforge.texture-residency-plan.v1`). */
  readonly plan: { readonly schema: typeof NATIVE_TEXTURE_RESIDENCY_SCHEMA; readonly planSha256: string; readonly images: readonly { readonly uri: string; readonly dropLevels: number }[] };
  /** Device bytes of the staged textures with their full chains, and as planned. */
  readonly fullTextureBytes: number;
  readonly residentTextureBytes: number;
  /** Planned textures by levels dropped, 0..7 (7: seven or more). */
  readonly levelsDropped: readonly number[];
}

const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

async function readHeader(file: string): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(48);
    await handle.read(header, 0, 48, 0);
    return header;
  } finally { await handle.close(); }
}

/** Device bytes of a KTX2's levels from `first` down (BC blocks, or RGBA8 for formats 37/43). */
function levelBytes(header: Buffer, first: number): number {
  const format = header.readUInt32LE(12);
  const levels = Math.max(1, header.readUInt32LE(40));
  let bytes = 0;
  for (let level = first; level < levels; level++) {
    const width = Math.max(1, header.readUInt32LE(20) >> level), height = Math.max(1, header.readUInt32LE(24) >> level);
    bytes += format === 37 || format === 43 ? width * height * 4 : Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
  }
  return bytes;
}

/**
 * The service plan for a staged tree: the staged master names each image by
 * the file it uploads (a GPU variant or the source), the closure's master
 * by the source URI the derivative keys on; images correspond by index.
 */
export async function nativeTextureResidencyPlan(input: {
  readonly closureMasterPath: string;
  readonly stagedMasterPath: string;
  readonly levels: ReadonlyMap<string, number>;
  readonly density: NativeTextureDensityPlan;
}): Promise<NativeTextureResidency> {
  type Images = { images?: { uri?: string }[] };
  const [source, staged] = await Promise.all([input.closureMasterPath, input.stagedMasterPath].map(async (file) => JSON.parse(await fs.readFile(file, 'utf8')) as Images));
  const dims = new Map(input.density.images.map((image) => [image.uri, image]));
  const directory = path.dirname(input.stagedMasterPath);
  const images: { uri: string; dropLevels: number }[] = [];
  const levelsDropped = [0, 0, 0, 0, 0, 0, 0, 0];
  let fullTextureBytes = 0, residentTextureBytes = 0;
  const counted = new Set<string>();
  for (const [index, image] of (source!.images ?? []).entries()) {
    const finest = image.uri === undefined ? undefined : input.levels.get(image.uri);
    const stagedUri = staged!.images?.[index]?.uri;
    if (finest === undefined || !stagedUri || counted.has(stagedUri)) continue;
    counted.add(stagedUri);
    const header = await readHeader(path.join(directory, stagedUri));
    if (!header.subarray(0, 12).equals(KTX2_MAGIC)) throw new Error(`native_texture_residency_invalid: ${stagedUri} is not KTX2`);
    const expected = dims.get(image.uri!)!;
    const levels = Math.max(1, header.readUInt32LE(40));
    if (header.readUInt32LE(20) !== expected.width || header.readUInt32LE(24) !== expected.height) {
      throw new Error(`native_texture_residency_dims_mismatch: ${stagedUri} is ${header.readUInt32LE(20)}x${header.readUInt32LE(24)}, the density derivative says ${expected.width}x${expected.height}`);
    }
    // A block-compressed base must be whole 4x4 blocks (RGBA8, formats 37
    // and 43, has no blocks): keep the finest level that is.
    const width = header.readUInt32LE(20), height = header.readUInt32LE(24), format = header.readUInt32LE(12);
    let dropLevels = Math.min(finest, levels - 1);
    if (format !== 37 && format !== 43) while (dropLevels > 0 && (((width >> dropLevels) % 4) !== 0 || ((height >> dropLevels) % 4) !== 0)) dropLevels -= 1;
    fullTextureBytes += levelBytes(header, 0);
    residentTextureBytes += levelBytes(header, dropLevels);
    levelsDropped[Math.min(7, dropLevels)]! += 1;
    if (dropLevels > 0) images.push({ uri: stagedUri, dropLevels });
  }
  images.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  const planSha256 = createHash('sha256').update(JSON.stringify([input.density.manifestSha256, images])).digest('hex');
  return { plan: { schema: NATIVE_TEXTURE_RESIDENCY_SCHEMA, planSha256, images }, fullTextureBytes, residentTextureBytes, levelsDropped };
}
