/**
 * Render-only map derivatives bound to a published map version.
 *
 * Maps built by a map pipeline that produces them carry these files in their
 * native closure. Map versions published before it get them from a backfill
 * (SimCloud `reconcile-map-derivatives.ts`). A native asset set is immutable,
 * so the backfill publishes each derivative as its own *derivative set* (a
 * `native_map_asset_sets` row with contract `simforge.map-derivative-set.v1`
 * for the same map version, never bound as `mv.native_map_asset_set_id`, so
 * every closure query ignores it) and records a small summary in
 * `map_versions.descriptor.<key>` naming that set. The native lease and the
 * worker prewarm serve its members as ordinary map members, the way
 * `descriptor.ambientTurnVerdicts` rides with the closure. Closure members
 * always win over derivative members of the same path.
 *
 * - `geometryLod`: `derived/geometry-lod/*` (docs/engineering/map-geometry-lod.md)
 * - `texturesFullBc7`: `derived/textures-full-bc7/*`, the full-resolution
 *   GPU-block texture tier (docs/engineering/map-texture-variants.md)
 *
 * Member lists never live in the descriptor: a texture tier has up to ~14k
 * members, and descriptors are read in bulk through the Data API (1 MB cap).
 */

export const MAP_DERIVATIVE_SET_CONTRACT = "simforge.map-derivative-set.v1";

export interface MapDerivativeKind {
  /** `map_versions.descriptor` key of the binding. */
  key: "geometryLod" | "texturesFullBc7";
  directory: string;
  schema: string;
}

export const MAP_DERIVATIVES: readonly MapDerivativeKind[] = [
  { key: "geometryLod", directory: "derived/geometry-lod", schema: "simforge.map-geometry-lod.v1" },
  { key: "texturesFullBc7", directory: "derived/textures-full-bc7", schema: "simforge.map-texture-variant.v1" },
];

/** SQL: the descriptor bindings of `mv` as one JSON object (small summaries only). */
export const MAP_DERIVATIVE_DESCRIPTOR_SQL = `jsonb_build_object(${MAP_DERIVATIVES.map((kind) => `'${kind.key}', mv.descriptor->'${kind.key}'`).join(", ")})`;

/**
 * SQL joins from `mv` to the members of its ready derivative sets, as
 * `ds` (set), `dm` (member), `db` (verified blob).
 */
export const MAP_DERIVATIVE_MEMBERS_JOIN_SQL = `
  JOIN simforge.native_map_asset_sets ds
    ON ds.map_version_id = mv.id AND ds.workspace_id = mv.workspace_id
   AND ds.asset_set_state = 'available' AND ds.contract_version = '${MAP_DERIVATIVE_SET_CONTRACT}'
   AND ds.id IN (${MAP_DERIVATIVES.map((kind) => `CASE WHEN mv.descriptor->'${kind.key}'->>'state' = 'ready' THEN mv.descriptor->'${kind.key}'->>'assetSetId' END`).join(", ")})
  JOIN simforge.native_map_asset_members dm ON dm.asset_set_id = ds.id
  JOIN simforge.native_map_asset_blobs db ON db.id = dm.blob_id AND db.verification_state = 'verified'`;

export interface MapDerivativeMember {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface MapDerivativeBinding {
  kind: MapDerivativeKind;
  buildKey: string;
  manifestSha256: string;
  assetSetId: string;
  objectCount: number;
}

/** A member row of a derivative set (`MAP_DERIVATIVE_MEMBERS_JOIN_SQL`). */
export interface MapDerivativeMemberRow {
  set_id: string;
  relative_path: string;
  sha256: string;
  byte_length: number | string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SET_ID = /^usnset_[a-z0-9_]{1,64}$/;

function parseBinding(kind: MapDerivativeKind, value: unknown): MapDerivativeBinding | null {
  if (!value || typeof value !== "object") return null;
  const binding = value as Record<string, unknown>;
  if (binding.state !== "ready") return null;
  if (binding.schema !== kind.schema || typeof binding.buildKey !== "string" || !SHA256.test(binding.buildKey)
    || typeof binding.manifestSha256 !== "string" || !SHA256.test(binding.manifestSha256)
    || typeof binding.assetSetId !== "string" || !SET_ID.test(binding.assetSetId)
    || typeof binding.objectCount !== "number" || !Number.isSafeInteger(binding.objectCount) || binding.objectCount < 1) {
    throw new Error(`map_derivative_descriptor_invalid:${kind.key}`);
  }
  return { kind, buildKey: binding.buildKey, manifestSha256: binding.manifestSha256, assetSetId: binding.assetSetId, objectCount: binding.objectCount };
}

/**
 * The ready bindings of a descriptor (or of `MAP_DERIVATIVE_DESCRIPTOR_SQL`'s
 * object). Not ready (never built, building, failed) binds nothing; a ready
 * binding that is malformed throws: it can only come from a broken backfill.
 */
export function boundMapDerivatives(descriptor: unknown): MapDerivativeBinding[] {
  const value = typeof descriptor === "string" ? JSON.parse(descriptor) as unknown : descriptor;
  if (!value || typeof value !== "object") return [];
  const bindings: MapDerivativeBinding[] = [];
  for (const kind of MAP_DERIVATIVES) {
    const binding = parseBinding(kind, (value as Record<string, unknown>)[kind.key]);
    if (binding) bindings.push(binding);
  }
  return bindings;
}

/**
 * The members of the bound derivative sets, proven complete against their
 * bindings (member count, manifest digest, paths inside the kind's
 * directory), sorted by path. A binding whose set is incomplete is a broken
 * backfill: `map_derivative_member_unavailable`.
 */
export function derivativeMembers(bindings: readonly MapDerivativeBinding[], rows: readonly MapDerivativeMemberRow[]): MapDerivativeMember[] {
  const members: MapDerivativeMember[] = [];
  for (const binding of bindings) {
    const own = rows.filter((row) => row.set_id === binding.assetSetId);
    const prefix = `${binding.kind.directory}/`;
    const manifest = own.find((row) => row.relative_path === `${prefix}manifest.json`);
    if (own.length !== binding.objectCount || !manifest || manifest.sha256 !== binding.manifestSha256
      || own.some((row) => !row.relative_path.startsWith(prefix) || !SHA256.test(row.sha256))) {
      throw new Error(`map_derivative_member_unavailable:${binding.kind.key}`);
    }
    for (const row of own) members.push({ relativePath: row.relative_path, sha256: row.sha256, byteLength: Number(row.byte_length) });
  }
  return members.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

/** Derivative members the native closure does not already carry. */
export function mapDerivativeExtraMembers(members: readonly MapDerivativeMember[], closurePaths: ReadonlySet<string>): MapDerivativeMember[] {
  return members.filter((member) => !closurePaths.has(member.relativePath));
}

/**
 * One digest over every ready binding (kind, build key, manifest, set):
 * changes whenever a backfill binds, rebuilds or unbinds a derivative.
 * Undefined when nothing is bound.
 */
export function mapDerivativesDigest(bindings: readonly MapDerivativeBinding[], hash: (text: string) => string): string | undefined {
  if (bindings.length === 0) return undefined;
  return hash(JSON.stringify(bindings.map((binding) => [binding.kind.key, binding.buildKey, binding.manifestSha256, binding.assetSetId])));
}
