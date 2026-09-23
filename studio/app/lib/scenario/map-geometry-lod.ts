/**
 * Map geometry derivatives bound to a published map version
 * (docs/engineering/map-geometry-lod.md).
 *
 * Maps built by a map pipeline that produces `derived/geometry-lod/*` carry
 * those files in their native closure. Map versions published before it get
 * them from a backfill (SimCloud `reconcile-geometry-lod-derivatives.ts`),
 * which cannot add members to an immutable native asset set; it uploads the
 * files content-addressed, registers them as verified native blobs and binds
 * them in `map_versions.descriptor.geometryLod`. The native lease and the
 * worker prewarm read them from there, the way `descriptor.ambientTurnVerdicts`
 * rides with the closure.
 */

export const GEOMETRY_LOD_SCHEMA = "simforge.map-geometry-lod.v1";
export const GEOMETRY_LOD_DIRECTORY = "derived/geometry-lod";

export interface GeometryLodMember {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface GeometryLodBinding {
  buildKey: string;
  manifestSha256: string;
  members: GeometryLodMember[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^derived\/geometry-lod\/(?:[a-z0-9-]+\/)*[A-Za-z0-9._-]+$/;

/**
 * The members a `descriptor.geometryLod` binds, or null when the map version
 * binds none (never built, building, failed). A descriptor that claims to be
 * ready but is malformed throws: it can only come from a broken backfill.
 */
export function boundGeometryLod(descriptor: unknown): GeometryLodBinding | null {
  if (!descriptor || typeof descriptor !== "object") return null;
  const value = descriptor as Record<string, unknown>;
  if (value.state !== "ready") return null;
  if (value.schema !== GEOMETRY_LOD_SCHEMA || typeof value.buildKey !== "string" || !SHA256.test(value.buildKey)
    || typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256) || !Array.isArray(value.members)) {
    throw new Error("geometry_lod_descriptor_invalid");
  }
  const members: GeometryLodMember[] = [];
  const seen = new Set<string>();
  for (const entry of value.members as unknown[]) {
    const member = entry as Record<string, unknown>;
    if (typeof member.relativePath !== "string" || !SAFE_PATH.test(member.relativePath) || member.relativePath.split("/").includes("..")
      || typeof member.sha256 !== "string" || !SHA256.test(member.sha256)
      || typeof member.byteLength !== "number" || !Number.isSafeInteger(member.byteLength) || member.byteLength < 0
      || seen.has(member.relativePath)) {
      throw new Error("geometry_lod_descriptor_invalid");
    }
    seen.add(member.relativePath);
    members.push({ relativePath: member.relativePath, sha256: member.sha256, byteLength: member.byteLength });
  }
  const manifest = members.find((member) => member.relativePath === `${GEOMETRY_LOD_DIRECTORY}/manifest.json`);
  if (!manifest || manifest.sha256 !== value.manifestSha256) throw new Error("geometry_lod_descriptor_invalid");
  members.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return { buildKey: value.buildKey, manifestSha256: value.manifestSha256, members };
}

/**
 * Descriptor-bound members that the native closure does not already carry
 * (a pipeline-built closure has them as set members; those win).
 */
export function geometryLodExtraMembers(binding: GeometryLodBinding | null, closurePaths: ReadonlySet<string>): GeometryLodMember[] {
  if (!binding) return [];
  return binding.members.filter((member) => !closurePaths.has(member.relativePath));
}
