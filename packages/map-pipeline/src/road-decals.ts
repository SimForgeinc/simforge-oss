/**
 * Road decal derivative (`derived/road-decals/manifest.json`, schema
 * `simforge.map-road-decals.v1`).
 *
 * RoadRunner exports road wear (oil paths, oil stains, cracks) as
 * alpha-blended decal layers over the road surface: materials named
 * `<Asset>_<Group>_<Surface>_Layer<N>` with N >= 1 and `alphaMode: BLEND`
 * (e.g. `OilPath01_Road_Roads_Road_Layer1`). The native renderer composited
 * them at their authored opacity as plain albedo, so the lane-long oil paths
 * read as dark streaks down every lane; Unreal (CARLA) renders the same
 * layers almost invisibly. This derivative lists the wear layers of a master
 * and carries one opacity scale, calibrated once (below); the renderer
 * multiplies each listed material's base-colour alpha by it.
 *
 * Only wear families are listed. Other blended layers (lane paint, symbols,
 * utilities, tram rails) are content, not wear, and keep their opacity.
 *
 * It is a pure function of `master.gltf` (material names and alpha modes),
 * so it is derived at ingest for new maps and backfilled as a derivative set
 * for published map versions (the master does not change: no new version).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from './closure.js';

export const ROAD_DECALS_DIR = 'derived/road-decals';
export const ROAD_DECALS_SCHEMA = 'simforge.map-road-decals.v1';
/** Bumped whenever the classification or the opacity changes. */
export const ROAD_DECALS_REVISION = 1;

/**
 * RoadRunner wear-decal asset families (the asset name before the group).
 */
export const ROAD_WEAR_FAMILIES = ['OilPath', 'OilStains', 'LinearCracks', 'Cracks'] as const;

/**
 * Opacity scale for wear layers, fitted on the 8-location CEO comparison
 * (Easterbrook, docs/engineering/map-road-decals.md): in the RoadRunner
 * decal pixels, CARLA shows 1.000 +- 0.032 of the surrounding road's
 * luminance; SimForge showed 0.877 at the authored opacity and 0.972 at 0.2,
 * the largest scale within one standard deviation of CARLA.
 */
export const ROAD_DECAL_OPACITY_SCALE = 0.2;

const LAYER = /_Layer([1-9]\d*)$/;
const WEAR = new RegExp(`^(${ROAD_WEAR_FAMILIES.join('|')})\\d`);

export interface RoadDecalMaterial {
  /** glTF material index in the master. */
  readonly index: number;
  /** glTF material name: what the renderer matches. */
  readonly name: string;
  readonly family: (typeof ROAD_WEAR_FAMILIES)[number];
  readonly layer: number;
}

export interface RoadDecalsManifest {
  readonly schema: typeof ROAD_DECALS_SCHEMA;
  readonly builder: { readonly revision: number; readonly fingerprint: string };
  readonly buildKey: string;
  readonly source: { readonly master: { readonly path: 'master.gltf'; readonly sha256: string } };
  readonly opacityScale: number;
  readonly materials: readonly RoadDecalMaterial[];
  /** Blended layer materials left alone (not wear), by name. */
  readonly keptBlendedLayers: readonly string[];
}

interface GltfMaterial { readonly name?: unknown; readonly alphaMode?: unknown }

/** The wear-decal materials of a master, and the blended layers kept as authored. */
export function classifyRoadDecals(masterJson: { readonly materials?: readonly GltfMaterial[] }): {
  materials: RoadDecalMaterial[];
  keptBlendedLayers: string[];
} {
  const materials: RoadDecalMaterial[] = [];
  const keptBlendedLayers: string[] = [];
  for (const [index, material] of (masterJson.materials ?? []).entries()) {
    const name = typeof material.name === 'string' ? material.name : '';
    const layer = LAYER.exec(name);
    if (material.alphaMode !== 'BLEND' || !layer) continue;
    const family = WEAR.exec(name)?.[1] as RoadDecalMaterial['family'] | undefined;
    if (family) materials.push({ index, name, family, layer: Number(layer[1]) });
    else keptBlendedLayers.push(name);
  }
  return { materials, keptBlendedLayers: keptBlendedLayers.sort() };
}

export function roadDecalsFingerprint(): string {
  return sha256(canonicalJson({ revision: ROAD_DECALS_REVISION, families: ROAD_WEAR_FAMILIES, opacityScale: ROAD_DECAL_OPACITY_SCALE }));
}

export function roadDecalsBuildKey(input: { masterSha256: string; fingerprint: string }): string {
  return sha256(canonicalJson({ schema: ROAD_DECALS_SCHEMA, master: input.masterSha256, fingerprint: input.fingerprint }));
}

/** The manifest for a master (its bytes, for the binding digest). */
export function roadDecalsManifest(masterBytes: Uint8Array): RoadDecalsManifest {
  const masterSha256 = sha256(masterBytes);
  const masterJson = JSON.parse(Buffer.from(masterBytes).toString('utf8')) as { materials?: GltfMaterial[] };
  const fingerprint = roadDecalsFingerprint();
  return {
    schema: ROAD_DECALS_SCHEMA,
    builder: { revision: ROAD_DECALS_REVISION, fingerprint },
    buildKey: roadDecalsBuildKey({ masterSha256, fingerprint }),
    source: { master: { path: 'master.gltf', sha256: masterSha256 } },
    opacityScale: ROAD_DECAL_OPACITY_SCALE,
    ...classifyRoadDecals(masterJson),
  };
}

/**
 * Write `manifest.json` for `<masterDir>/master.gltf` into `outputDir`.
 * A master without wear layers still gets a manifest (an empty list), so a
 * map says explicitly that it has nothing to calm down.
 */
export async function buildRoadDecals(options: { masterDir: string; outputDir: string }): Promise<RoadDecalsManifest> {
  const manifest = roadDecalsManifest(await readFile(path.join(options.masterDir, 'master.gltf')));
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, 'manifest.json'), `${canonicalJson(manifest)}\n`);
  return manifest;
}

/** Validate a manifest read back (backfill, renderer planning). */
export function parseRoadDecalsManifest(value: unknown): RoadDecalsManifest {
  const m = value as Partial<RoadDecalsManifest> | null;
  if (!m || m.schema !== ROAD_DECALS_SCHEMA) throw new Error(`road decals manifest: schema ${String(m?.schema)} (${ROAD_DECALS_SCHEMA})`);
  if (typeof m.buildKey !== 'string' || !/^[0-9a-f]{64}$/.test(m.buildKey)) throw new Error('road decals manifest: buildKey');
  if (m.source?.master?.path !== 'master.gltf' || typeof m.source.master.sha256 !== 'string') throw new Error('road decals manifest: source.master');
  if (typeof m.opacityScale !== 'number' || !(m.opacityScale >= 0 && m.opacityScale <= 1)) throw new Error('road decals manifest: opacityScale');
  if (!Array.isArray(m.materials) || !m.materials.every((x) => Number.isInteger(x.index) && typeof x.name === 'string')) throw new Error('road decals manifest: materials');
  if (!m.builder || typeof m.builder.revision !== 'number' || typeof m.builder.fingerprint !== 'string') throw new Error('road decals manifest: builder');
  return m as RoadDecalsManifest;
}
