import type { NativeTextureMemberSource } from './texture-profile.js';

/**
 * The map's road decal derivative (`derived/road-decals/manifest.json`,
 * schema `simforge.map-road-decals.v1`, built by
 * `@simforge-oss/map-pipeline` `buildRoadDecals`, docs/engineering/map-road-decals.md):
 * the RoadRunner wear-decal layers of the master and their calibrated
 * opacity. The service applies it when the scene loads.
 */
export const NATIVE_ROAD_DECALS_MANIFEST = 'derived/road-decals/manifest.json';
const ROAD_DECALS_SCHEMA = 'simforge.map-road-decals.v1';

export interface NativeRoadDecalsPlan {
  readonly members: readonly string[];
  readonly manifestSha256: string;
  readonly buildKey: string;
  readonly opacityScale: number;
  readonly materials: number;
}

/**
 * `undefined` when the map carries no derivative (decals composite at their
 * authored opacity; the evidence says so). A derivative bound to another
 * master or malformed is an error, never a silent authored-opacity render.
 */
export async function planNativeRoadDecals(source: NativeTextureMemberSource): Promise<NativeRoadDecalsPlan | undefined> {
  const manifestSha256 = source.sha256(NATIVE_ROAD_DECALS_MANIFEST);
  if (!manifestSha256) return undefined;
  let manifest: { schema?: unknown; buildKey?: unknown; opacityScale?: unknown; materials?: unknown; source?: { master?: { path?: unknown; sha256?: unknown } } };
  try {
    manifest = JSON.parse(await source.readText(NATIVE_ROAD_DECALS_MANIFEST)) as typeof manifest;
  } catch (error) {
    throw new Error(`native_road_decals_invalid: ${NATIVE_ROAD_DECALS_MANIFEST} is not JSON (${(error as Error).message})`);
  }
  if (manifest.schema !== ROAD_DECALS_SCHEMA) throw new Error(`native_road_decals_invalid: schema ${String(manifest.schema)} (${ROAD_DECALS_SCHEMA})`);
  if (typeof manifest.buildKey !== 'string') throw new Error('native_road_decals_invalid: no buildKey');
  if (typeof manifest.opacityScale !== 'number' || !(manifest.opacityScale >= 0 && manifest.opacityScale <= 1)) {
    throw new Error('native_road_decals_invalid: opacityScale');
  }
  if (!Array.isArray(manifest.materials)) throw new Error('native_road_decals_invalid: materials');
  const master = manifest.source?.master;
  if (master?.path !== 'master.gltf' || master.sha256 !== source.sha256('master.gltf')) {
    throw new Error('native_road_decals_master_mismatch: the derivative was built from another master.gltf');
  }
  return {
    members: [NATIVE_ROAD_DECALS_MANIFEST],
    manifestSha256,
    buildKey: manifest.buildKey,
    opacityScale: manifest.opacityScale,
    materials: manifest.materials.length,
  };
}
