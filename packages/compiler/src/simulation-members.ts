/**
 * The simulation members of a published map version: every closure member a
 * simulation reads. ONE list, from which the map pin
 * (`simforge.map-pin-closure/v1`), the CPU runner's presigned member set and
 * the server/editor closure loaders are generated. A change to any of these
 * members changes what a simulation computes, so it mints a NEW map version
 * (the publish-time assert: a version's simulation-closure digest never
 * changes).
 *
 * `derived/ground/ground-mesh.bin` (engine 0.11 ground contact,
 * docs/engineering/ground-height.md) is present only on versions published
 * with the ground derivative; versions published before it keep their
 * simulation closure (and pins) unchanged.
 */
export const SIMULATION_MAP_MEMBERS = Object.freeze({
  /** Members matched by exact relative path. */
  exact: Object.freeze([
    'map.xodr',
    'topology-index.json.gz',
    'signals.geojson.gz',
    'derived/topology-derived.json.gz',
    'derived/locations.json.gz',
    'derived/ground/ground-mesh.bin',
  ] as const),
  /** Members matched by relative-path prefix (the collider derivative names its file). */
  prefixes: Object.freeze(['3d/variants/static-colliders'] as const),
});

/** The ground member (optional per version, see {@link SIMULATION_MAP_MEMBERS}). */
export const GROUND_MESH_MEMBER = 'derived/ground/ground-mesh.bin';

export function isSimulationMapMember(relativePath: string): boolean {
  return (SIMULATION_MAP_MEMBERS.exact as readonly string[]).includes(relativePath)
    || SIMULATION_MAP_MEMBERS.prefixes.some((prefix) => relativePath.startsWith(prefix));
}

/**
 * SQL predicate selecting the simulation members of an asset set, over a
 * `browser_asset_members` alias. Generated from {@link SIMULATION_MAP_MEMBERS};
 * the paths are constants, never user input.
 */
export function simulationMemberSqlPredicate(pathColumn: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const exact = SIMULATION_MAP_MEMBERS.exact.map(quote).join(', ');
  const prefixes = SIMULATION_MAP_MEMBERS.prefixes.map((prefix) => `${pathColumn} LIKE ${quote(`${prefix}%`)}`).join(' OR ');
  return `(${pathColumn} IN (${exact}) OR ${prefixes})`;
}

/**
 * Member URLs a simulation loads, under a version's browser-asset root. The
 * `3d/manifest.json` entry locates the collider derivative. `ground` is
 * requested only when the version carries it; a version that does must be
 * loaded with it (a declared member that fails to load fails the load).
 */
export function simulationMemberSources(root: string, options: { readonly ground: boolean }) {
  return {
    manifest: `${root}/3d/manifest.json`,
    topology: `${root}/topology-index.json.gz`,
    derivedTopology: `${root}/derived/topology-derived.json.gz`,
    locations: `${root}/derived/locations.json.gz`,
    xodr: `${root}/map.xodr`,
    signals: `${root}/signals.geojson.gz`,
    ...(options.ground ? { ground: `${root}/${GROUND_MESH_MEMBER}` } : {}),
  };
}
