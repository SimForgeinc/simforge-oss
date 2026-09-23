/**
 * Render-only map derivatives bound to a published map version by descriptor.
 *
 * Maps built by a map pipeline that produces them carry these files in their
 * native closure. Map versions published before it get them from a backfill
 * (SimCloud `reconcile-map-derivatives.ts`), which cannot add members to an
 * immutable native asset set: it uploads the files content-addressed,
 * registers them as verified native blobs and binds them in
 * `map_versions.descriptor.<key>`. The native lease and the worker prewarm
 * serve them from there, the way `descriptor.ambientTurnVerdicts` rides with
 * the closure. Closure members always win over descriptor members of the same
 * path.
 *
 * - `geometryLod`: `derived/geometry-lod/*` (docs/engineering/map-geometry-lod.md)
 * - `texturesFullBc7`: `derived/textures-full-bc7/*`, the full-resolution
 *   GPU-block texture tier (docs/engineering/map-texture-variants.md)
 */

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

/** SQL: the descriptor bindings of `mv` as one JSON object (only these keys). */
export const MAP_DERIVATIVE_DESCRIPTOR_SQL = `jsonb_build_object(${MAP_DERIVATIVES.map((kind) => `'${kind.key}', mv.descriptor->'${kind.key}'`).join(", ")})`;

export interface MapDerivativeMember {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface MapDerivativeBinding {
  kind: MapDerivativeKind;
  buildKey: string;
  manifestSha256: string;
  members: MapDerivativeMember[];
}

const SHA256 = /^[a-f0-9]{64}$/;

function parseBinding(kind: MapDerivativeKind, value: unknown): MapDerivativeBinding | null {
  if (!value || typeof value !== "object") return null;
  const binding = value as Record<string, unknown>;
  if (binding.state !== "ready") return null;
  const invalid = () => new Error(`map_derivative_descriptor_invalid:${kind.key}`);
  if (binding.schema !== kind.schema || typeof binding.buildKey !== "string" || !SHA256.test(binding.buildKey)
    || typeof binding.manifestSha256 !== "string" || !SHA256.test(binding.manifestSha256) || !Array.isArray(binding.members)) {
    throw invalid();
  }
  const prefix = `${kind.directory}/`;
  const members: MapDerivativeMember[] = [];
  const seen = new Set<string>();
  for (const entry of binding.members as unknown[]) {
    const member = entry as Record<string, unknown>;
    const relativePath = member.relativePath;
    if (typeof relativePath !== "string" || !relativePath.startsWith(prefix)
      || !/^[A-Za-z0-9._\/-]+$/.test(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")
      || typeof member.sha256 !== "string" || !SHA256.test(member.sha256)
      || typeof member.byteLength !== "number" || !Number.isSafeInteger(member.byteLength) || member.byteLength < 0
      || seen.has(relativePath)) {
      throw invalid();
    }
    seen.add(relativePath);
    members.push({ relativePath, sha256: member.sha256, byteLength: member.byteLength });
  }
  const manifest = members.find((member) => member.relativePath === `${prefix}manifest.json`);
  if (!manifest || manifest.sha256 !== binding.manifestSha256) throw invalid();
  members.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return { kind, buildKey: binding.buildKey, manifestSha256: binding.manifestSha256, members };
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

/** Descriptor-bound members the native closure does not already carry, sorted by path. */
export function mapDerivativeExtraMembers(bindings: readonly MapDerivativeBinding[], closurePaths: ReadonlySet<string>): MapDerivativeMember[] {
  return bindings.flatMap((binding) => binding.members)
    .filter((member) => !closurePaths.has(member.relativePath))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

/**
 * One digest over every ready binding (kind, build key, manifest): changes
 * whenever a backfill binds, rebuilds or unbinds a derivative. Undefined when
 * nothing is bound.
 */
export function mapDerivativesDigest(bindings: readonly MapDerivativeBinding[], hash: (text: string) => string): string | undefined {
  if (bindings.length === 0) return undefined;
  return hash(JSON.stringify(bindings.map((binding) => [binding.kind.key, binding.buildKey, binding.manifestSha256])));
}
