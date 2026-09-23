import { assertSafeNativeMapMemberPath } from './map-closure.js';
import type { NativeTextureMemberSource } from './texture-profile.js';

/**
 * The map's geometry LOD derivative (`derived/geometry-lod/`, schema
 * `simforge.map-geometry-lod.v1`, docs/engineering/map-geometry-lod.md) as
 * the native renderer consumes it: the index, `lod.gltf` + `lod.bin` and the
 * impostor atlases. The sensor proxy (`sensor.gltf`) is not read: lidar and
 * radar trace the full-detail scene.
 */
export const NATIVE_GEOMETRY_LOD_DIRECTORY = 'derived/geometry-lod';
export const NATIVE_GEOMETRY_LOD_MANIFEST = `${NATIVE_GEOMETRY_LOD_DIRECTORY}/manifest.json`;
const GEOMETRY_LOD_SCHEMA = 'simforge.map-geometry-lod.v1';

export type NativeGeometryLodMode = 'auto' | 'off';

export interface NativeGeometryLodPlan {
  /** Closure members the renderer reads (map-root relative), manifest first. */
  readonly members: readonly string[];
  readonly manifestSha256: string;
  readonly buildKey: string;
}

interface Member { readonly path: string; readonly sha256: string }
interface Manifest {
  readonly schema?: unknown;
  readonly buildKey?: unknown;
  readonly source?: { readonly master?: Member };
  readonly files?: { readonly lod?: Member; readonly lodBuffer?: Member; readonly images?: readonly Member[] };
}

/**
 * What a render with geometry LOD `mode` reads from the closure: `undefined`
 * when the mode is `off` or the map carries no derivative (full detail; the
 * run's evidence says which). A derivative that is present but bound to
 * another master, malformed, or missing a member is an error, never a
 * silent full-detail render.
 */
export async function planNativeGeometryLod(
  mode: NativeGeometryLodMode,
  source: NativeTextureMemberSource,
): Promise<NativeGeometryLodPlan | undefined> {
  if (mode === 'off') return undefined;
  const manifestSha256 = source.sha256(NATIVE_GEOMETRY_LOD_MANIFEST);
  if (!manifestSha256) return undefined;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await source.readText(NATIVE_GEOMETRY_LOD_MANIFEST)) as Manifest;
  } catch (error) {
    throw new Error(`native_geometry_lod_invalid: ${NATIVE_GEOMETRY_LOD_MANIFEST} is not JSON (${(error as Error).message})`);
  }
  if (manifest.schema !== GEOMETRY_LOD_SCHEMA) throw new Error(`native_geometry_lod_invalid: schema ${String(manifest.schema)} (${GEOMETRY_LOD_SCHEMA})`);
  if (typeof manifest.buildKey !== 'string') throw new Error('native_geometry_lod_invalid: no buildKey');
  const master = manifest.source?.master;
  if (master?.path !== 'master.gltf' || master.sha256 !== source.sha256('master.gltf')) {
    throw new Error('native_geometry_lod_master_mismatch: the derivative was built from another master.gltf');
  }
  const files = manifest.files;
  if (!files?.lod || !files.lodBuffer || !Array.isArray(files.images)) throw new Error('native_geometry_lod_invalid: files.lod/lodBuffer/images');
  if (files.lod.path !== 'lod.gltf') throw new Error(`native_geometry_lod_invalid: files.lod is ${files.lod.path} (the renderer reads lod.gltf)`);
  const members = [NATIVE_GEOMETRY_LOD_MANIFEST];
  for (const file of [files.lod, files.lodBuffer, ...files.images]) {
    const uri = `${NATIVE_GEOMETRY_LOD_DIRECTORY}/${file.path}`;
    assertSafeNativeMapMemberPath(uri);
    const sha256 = source.sha256(uri);
    if (!sha256) throw new Error(`native_geometry_lod_member_missing: ${uri}`);
    if (sha256 !== file.sha256) throw new Error(`native_geometry_lod_digest_mismatch: ${uri}`);
    members.push(uri);
  }
  return { members, manifestSha256, buildKey: manifest.buildKey };
}
