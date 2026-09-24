/**
 * Texture density derivative (`derived/texture-density/manifest.json`,
 * schema `simforge.map-texture-density.v1`).
 *
 * For every KTX2 image a master's materials sample, where in the map it is
 * drawn and how densely: a list of uses, each a horizontal world box
 * `[minX, minZ, maxX, maxZ]` (glTF frame, metres) and the lowest texel
 * density any triangle of that use maps the image at (texels of mip 0 per
 * metre). A render job combines it with its camera trajectory to find the
 * finest mip level each image can be sampled at (per-job static mip
 * residency, `@simforge-oss/render` `texture-residency.ts`), so the service
 * uploads only the levels a job can use.
 *
 * The density of a triangle is a lower bound of what the GPU's isotropic
 * LOD selection sees on any screen axis: with J the Jacobian of texel
 * coordinates (mip 0, after `KHR_texture_transform`) with respect to the
 * triangle's plane, sqrt((|J e1|^2 + |J e2|^2) / 2) for the plane's
 * orthonormal axes (J's Frobenius norm over sqrt 2), which never exceeds the
 * larger of the two axis derivatives the hardware takes. A use keeps the
 * lowest density of its triangles; an instance's density is the mesh's over
 * the instance's largest axis scale. Uses of one image are merged per
 * `cellM` grid cell (box union, lowest density): coarser, never less
 * conservative.
 *
 * A pure function of `master.gltf`, its buffers and the images' KTX2
 * headers, so it is derived at ingest for new maps and backfilled as a
 * derivative set for published map versions (no new map version).
 */
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from './closure.js';
import { maxScale, meshInstances, readAccessorFloat, readIndices, readMasterGeometry, transformPoint } from './geometry-lod/gltf-read.js';
import type { GltfDocument, MasterGeometry } from './geometry-lod/gltf-read.js';

export const TEXTURE_DENSITY_DIR = 'derived/texture-density';
export const TEXTURE_DENSITY_SCHEMA = 'simforge.map-texture-density.v1';
/** Bumped whenever the density bound, the merge or the layout changes. */
export const TEXTURE_DENSITY_REVISION = 1;
export const TEXTURE_DENSITY_CELL_M = 64;

/** One merged use: `[minX, minZ, maxX, maxZ, texelsPerMetre]`. */
export type TextureDensityUse = readonly [number, number, number, number, number];

export interface TextureDensityImage {
  /** The image's URI in the master (`images/<sha>.ktx2`). */
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly uses: readonly TextureDensityUse[];
}

export interface TextureDensityManifest {
  readonly schema: typeof TEXTURE_DENSITY_SCHEMA;
  readonly builder: { readonly revision: number; readonly fingerprint: string };
  readonly buildKey: string;
  readonly source: { readonly master: { readonly path: 'master.gltf'; readonly sha256: string } };
  readonly cellM: number;
  readonly images: readonly TextureDensityImage[];
}

export function textureDensityFingerprint(): string {
  return sha256(canonicalJson({ revision: TEXTURE_DENSITY_REVISION, cellM: TEXTURE_DENSITY_CELL_M }));
}

export function textureDensityBuildKey(input: { masterSha256: string; fingerprint: string }): string {
  return sha256(canonicalJson({ schema: TEXTURE_DENSITY_SCHEMA, master: input.masterSha256, fingerprint: input.fingerprint }));
}

const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Mip-0 size of a KTX2 file, from its header. */
export async function ktx2ImageSize(file: string): Promise<{ width: number; height: number }> {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(48);
    const { bytesRead } = await handle.read(header, 0, 48, 0);
    if (bytesRead < 48 || !header.subarray(0, 12).equals(KTX2_MAGIC)) throw new Error(`texture-density: ${file} is not a KTX2 file`);
    return { width: header.readUInt32LE(20), height: header.readUInt32LE(24) };
  } finally {
    await handle.close();
  }
}

/**
 * `linears`: the texture transform's linear part `[m00, m01, m10, m11]`
 * (u' = m00 u + m01 v, v' = m10 u + m11 v). A rotated transform carries both
 * rotation senses: the density is taken as the lower of the two, so the
 * bound holds whichever sense a loader applies.
 */
interface TextureSlot { readonly image: number; readonly texCoord: number; readonly linears: readonly (readonly [number, number, number, number])[] }

/** Every texture a material samples (glTF `*Texture` slots, extensions included). */
function materialSlots(document: GltfDocument, material: unknown): TextureSlot[] {
  const slots: TextureSlot[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.endsWith('Texture') && child && typeof child === 'object' && Number.isInteger((child as { index?: unknown }).index)) {
        const info = child as { index: number; texCoord?: number; extensions?: { KHR_texture_transform?: { scale?: number[]; rotation?: number; texCoord?: number } } };
        const texture = document.textures?.[info.index];
        const image = texture?.extensions?.KHR_texture_basisu?.source ?? texture?.source;
        if (image === undefined) continue;
        const transform = info.extensions?.KHR_texture_transform;
        const [sx, sy] = transform?.scale ?? [1, 1];
        const r = transform?.rotation ?? 0;
        // KHR_texture_transform: uv' = T * R * S * uv.
        const c = Math.cos(r), s = Math.sin(r);
        const linears: (readonly [number, number, number, number])[] = [[c * sx!, -s * sy!, s * sx!, c * sy!]];
        if (s !== 0) linears.push([c * sx!, s * sy!, -s * sx!, c * sy!]);
        slots.push({ image, texCoord: transform?.texCoord ?? info.texCoord ?? 0, linears });
      }
      walk(child);
    }
  };
  walk(material);
  return slots;
}

/**
 * Lowest texel density (texels per mesh-local metre) of a primitive's
 * triangles for one texture slot of `width` x `height` texels. 0 when a
 * triangle with area maps to a single texel position (it samples mip 0).
 */
function primitiveDensity(geometry: MasterGeometry, primitive: { attributes: Record<string, number>; indices?: number; mode?: number }, slot: TextureSlot, width: number, height: number): number {
  const uvAccessor = primitive.attributes[`TEXCOORD_${slot.texCoord}`];
  if (uvAccessor === undefined) return 0; // no UVs: every pixel samples one texel position
  if ((primitive.mode ?? 4) !== 4) return 0; // strips/fans/lines are not decomposed: take the finest level
  const positions = readAccessorFloat(geometry, primitive.attributes['POSITION']!);
  const uvs = readAccessorFloat(geometry, uvAccessor);
  const indices = readIndices(geometry, primitive);
  let lowest = Infinity;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = indices[t]!, i1 = indices[t + 1]!, i2 = indices[t + 2]!;
    const e1x = positions[i1 * 3]! - positions[i0 * 3]!, e1y = positions[i1 * 3 + 1]! - positions[i0 * 3 + 1]!, e1z = positions[i1 * 3 + 2]! - positions[i0 * 3 + 2]!;
    const e2x = positions[i2 * 3]! - positions[i0 * 3]!, e2y = positions[i2 * 3 + 1]! - positions[i0 * 3 + 1]!, e2z = positions[i2 * 3 + 2]! - positions[i0 * 3 + 2]!;
    const l = Math.hypot(e1x, e1y, e1z);
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    const doubleArea = Math.hypot(cx, cy, cz);
    if (!(l > 0) || !(doubleArea > 1e-12)) continue; // no area: rasterizes nothing
    // Plane coordinates: e1 = (l, 0), e2 = (p, q).
    const p = (e1x * e2x + e1y * e2y + e1z * e2z) / l;
    const q = doubleArea / l;
    // Texel-space edges (mip 0, after the texture transform).
    const du1 = uvs[i1 * 2]! - uvs[i0 * 2]!, dv1 = uvs[i1 * 2 + 1]! - uvs[i0 * 2 + 1]!;
    const du2 = uvs[i2 * 2]! - uvs[i0 * 2]!, dv2 = uvs[i2 * 2 + 1]! - uvs[i0 * 2 + 1]!;
    for (const [m00, m01, m10, m11] of slot.linears) {
      const u1x = width * (m00 * du1 + m01 * dv1), u1y = height * (m10 * du1 + m11 * dv1);
      const u2x = width * (m00 * du2 + m01 * dv2), u2y = height * (m10 * du2 + m11 * dv2);
      // J = U P^-1 with P = [[l, p], [0, q]]: columns u1 / l and (u2 - (p / l) u1) / q.
      const j1x = u1x / l, j1y = u1y / l;
      const j2x = (u2x - p * j1x) / q, j2y = (u2y - p * j1y) / q;
      const density = Math.sqrt((j1x * j1x + j1y * j1y + j2x * j2x + j2y * j2y) / 2);
      if (density < lowest) lowest = density;
    }
  }
  return Number.isFinite(lowest) ? lowest : 0;
}

/** Round a density down and a box outwards (canonical, never less conservative). */
function roundDown(value: number): number {
  if (value <= 0) return 0;
  const scale = 10 ** (3 - Math.floor(Math.log10(value)));
  return Math.floor(value * scale) / scale;
}

/**
 * The manifest for the master in `masterDir` (`master.gltf` and its
 * buffers). `imageSize` gives an image's mip-0 size by its master URI
 * (default: its KTX2 header under `masterDir`).
 */
export async function textureDensityManifest(masterDir: string, imageSize: (uri: string) => Promise<{ width: number; height: number }> = (uri) => ktx2ImageSize(path.join(masterDir, decodeURIComponent(uri)))): Promise<TextureDensityManifest> {
  const masterBytes = await readFile(path.join(masterDir, 'master.gltf'));
  const geometry = await readMasterGeometry(masterDir);
  const document = geometry.json;
  const headers = new Map<number, { uri: string; width: number; height: number }>();
  const sampled = new Set<number>();
  for (const texture of document.textures ?? []) {
    const image = texture.extensions?.KHR_texture_basisu?.source ?? texture.source;
    if (image !== undefined) sampled.add(image);
  }
  for (const index of [...sampled].sort((a, b) => a - b)) {
    const uri = document.images?.[index]?.uri;
    if (!uri || !uri.endsWith('.ktx2')) continue; // not a KTX2 image: never trimmed
    const { width, height } = await imageSize(uri);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`texture-density: ${uri} has size ${width}x${height}`);
    headers.set(index, { uri, width, height });
  }
  const meshes = document.meshes ?? [];
  const materials = document.materials ?? [];
  const slotsOf = materials.map((material) => materialSlots(document, material));
  const densityCache = new Map<string, { density: number; min: [number, number, number]; max: [number, number, number] }>();
  const cells = new Map<number, Map<string, [number, number, number, number, number]>>();
  for (const instance of meshInstances(document)) {
    const scale = maxScale(instance.world) || 1;
    for (const [primitiveIndex, primitive] of (meshes[instance.mesh]?.primitives ?? []).entries()) {
      if (primitive.material === undefined) continue;
      for (const slot of slotsOf[primitive.material] ?? []) {
        const header = headers.get(slot.image);
        if (!header) continue;
        const key = `${instance.mesh}/${primitiveIndex}/${slot.texCoord}/${slot.linears.flat().join(',')}/${header.width}x${header.height}`;
        let local = densityCache.get(key);
        if (!local) {
          const accessor = document.accessors![primitive.attributes['POSITION']!]!;
          let min = accessor.min as [number, number, number] | undefined;
          let max = accessor.max as [number, number, number] | undefined;
          if (!min || !max) {
            const positions = readAccessorFloat(geometry, primitive.attributes['POSITION']!);
            min = [Infinity, Infinity, Infinity]; max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, positions[i + k]!); max[k] = Math.max(max[k]!, positions[i + k]!); }
          }
          local = { density: primitiveDensity(geometry, primitive, slot, header.width, header.height), min, max };
          densityCache.set(key, local);
        }
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const x of [local.min[0], local.max[0]]) for (const y of [local.min[1], local.max[1]]) for (const z of [local.min[2], local.max[2]]) {
          const [wx, , wz] = transformPoint(instance.world, x, y, z);
          minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
        }
        const density = local.density / scale;
        const cell = `${Math.floor((minX + maxX) / 2 / TEXTURE_DENSITY_CELL_M)},${Math.floor((minZ + maxZ) / 2 / TEXTURE_DENSITY_CELL_M)}`;
        let byCell = cells.get(slot.image);
        if (!byCell) cells.set(slot.image, byCell = new Map());
        const merged = byCell.get(cell);
        if (!merged) byCell.set(cell, [minX, minZ, maxX, maxZ, density]);
        else {
          merged[0] = Math.min(merged[0], minX); merged[1] = Math.min(merged[1], minZ);
          merged[2] = Math.max(merged[2], maxX); merged[3] = Math.max(merged[3], maxZ);
          merged[4] = Math.min(merged[4], density);
        }
      }
    }
  }
  const images: TextureDensityImage[] = [];
  for (const [image, byCell] of cells) {
    const header = headers.get(image)!;
    const uses = [...byCell.values()]
      .map(([minX, minZ, maxX, maxZ, density]) => [Math.floor(minX * 100) / 100, Math.floor(minZ * 100) / 100, Math.ceil(maxX * 100) / 100, Math.ceil(maxZ * 100) / 100, roundDown(density)] as const)
      .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || x[4] - y[4]);
    images.push({ uri: header.uri, width: header.width, height: header.height, uses });
  }
  // Two image indices may name one file: one entry per URI, uses combined.
  const byUri = new Map<string, TextureDensityImage>();
  for (const image of images) {
    const seen = byUri.get(image.uri);
    byUri.set(image.uri, seen ? { ...seen, uses: [...seen.uses, ...image.uses].sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || x[4] - y[4]) } : image);
  }
  const masterSha256 = sha256(masterBytes);
  const fingerprint = textureDensityFingerprint();
  return {
    schema: TEXTURE_DENSITY_SCHEMA,
    builder: { revision: TEXTURE_DENSITY_REVISION, fingerprint },
    buildKey: textureDensityBuildKey({ masterSha256, fingerprint }),
    source: { master: { path: 'master.gltf', sha256: masterSha256 } },
    cellM: TEXTURE_DENSITY_CELL_M,
    images: [...byUri.values()].sort((x, y) => (x.uri < y.uri ? -1 : x.uri > y.uri ? 1 : 0)),
  };
}

/** Write `manifest.json` for `<masterDir>/master.gltf` into `outputDir`. */
export async function buildTextureDensity(options: { masterDir: string; outputDir: string; imageSize?: (uri: string) => Promise<{ width: number; height: number }> }): Promise<TextureDensityManifest> {
  const manifest = await textureDensityManifest(options.masterDir, options.imageSize);
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, 'manifest.json'), `${canonicalJson(manifest)}\n`);
  return manifest;
}

/** Validate a manifest read back (backfill, render planning). */
export function parseTextureDensityManifest(value: unknown): TextureDensityManifest {
  const m = value as Partial<TextureDensityManifest> | null;
  if (!m || m.schema !== TEXTURE_DENSITY_SCHEMA) throw new Error(`texture density manifest: schema ${String(m?.schema)} (${TEXTURE_DENSITY_SCHEMA})`);
  if (typeof m.buildKey !== 'string' || !/^[0-9a-f]{64}$/.test(m.buildKey)) throw new Error('texture density manifest: buildKey');
  if (m.source?.master?.path !== 'master.gltf' || typeof m.source.master.sha256 !== 'string') throw new Error('texture density manifest: source.master');
  if (!m.builder || typeof m.builder.revision !== 'number' || typeof m.builder.fingerprint !== 'string') throw new Error('texture density manifest: builder');
  if (typeof m.cellM !== 'number' || !(m.cellM > 0)) throw new Error('texture density manifest: cellM');
  if (!Array.isArray(m.images)) throw new Error('texture density manifest: images');
  for (const image of m.images) {
    if (typeof image.uri !== 'string' || !Number.isInteger(image.width) || !Number.isInteger(image.height) || !Array.isArray(image.uses)) throw new Error(`texture density manifest: image ${String(image?.uri)}`);
    for (const use of image.uses) {
      if (!Array.isArray(use) || use.length !== 5 || !use.every((v) => typeof v === 'number' && Number.isFinite(v)) || use[4]! < 0) throw new Error(`texture density manifest: use of ${image.uri}`);
    }
  }
  return m as TextureDensityManifest;
}
