/**
 * Map artifacts: discovery and loading of the immutable map corpus.
 *
 * The native compiler reads and validates a map directory (`MapBundle.load`);
 * this module owns the corpus layout (`DEV_ASSETS`), discovery, the memoised
 * `loadMap` and `createMapBundle` for callers that hold map-intel artifacts
 * without an installed directory.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { ambientTurnVerdictCount, canonicalJson, type AmbientTurnVerdictTable, type StaticMapCollider, type TopologyIndex } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';
import type { DerivedTopology, LocationCatalog } from '@simforge-oss/maps';
import { AMBIENT_TURN_VERDICTS_PATH, buildSimulationMapClosure, type MapClosureFiles } from '@simforge-oss/playback';

import { CliError } from './errors.js';
import { MapBundle, type InstalledMapBundle } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `packages/compiler/src` -> repo root; the CLI's checked-in templates and schemas live under it. */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

export const DEV_ASSETS = process.env['SCEN_DEV_ASSETS']
  ? path.resolve(process.env['SCEN_DEV_ASSETS'])
  : path.join(path.resolve(process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(homedir(), '.local', 'share'), 'simforge', 'maps')), 'dev-assets');

/** Artifact file names, relative to `dev-assets/<mapId>/`. */
export const ARTIFACTS = {
  topology: 'topology-index.json.gz',
  derived: path.join('derived', 'topology-derived.json.gz'),
  locations: path.join('derived', 'locations.json.gz'),
  searchIndex: 'search-index.json.gz',
} as const;

const MAP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_FILES = ['map.xodr', 'signals.geojson.gz', ARTIFACTS.topology, ARTIFACTS.derived, ARTIFACTS.locations];

export interface MapArtifactPresence {
  readonly topologyIndex: boolean;
  readonly derivedTopology: boolean;
  readonly locations: boolean;
  readonly searchIndex: boolean;
}

export function mapDir(mapId: string, root = DEV_ASSETS): string {
  if (!MAP_ID.test(mapId)) throw new CliError('unknown_map', `invalid map identifier "${mapId}"`, { path: '--map' });
  return path.join(path.resolve(root), mapId);
}

export function artifactPresence(mapId: string, root = DEV_ASSETS): MapArtifactPresence {
  const dir = mapDir(mapId, root);
  return {
    topologyIndex: existsSync(path.join(dir, ARTIFACTS.topology)),
    derivedTopology: existsSync(path.join(dir, ARTIFACTS.derived)),
    locations: existsSync(path.join(dir, ARTIFACTS.locations)),
    searchIndex: existsSync(path.join(dir, ARTIFACTS.searchIndex)),
  };
}

/** Complete installed bundles, in stable lexical order; no curated-name allowlist. */
export function availableMaps(root = DEV_ASSETS): string[] {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return entries.filter((entry) => MAP_ID.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())
    && REQUIRED_FILES.every((file) => statSync(path.join(root, entry.name, file), { throwIfNoEntry: false })?.isFile()))
    .map((entry) => entry.name).sort();
}

export function assertKnownMap(mapId: string, root = DEV_ASSETS): void {
  const dir = mapDir(mapId, root);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new CliError('unknown_map', `no installed map "${mapId}"`, { path: '--map', detail: { known: availableMaps(root), devAssets: root } });
  }
  const missing = REQUIRED_FILES.filter((file) => !statSync(path.join(dir, file), { throwIfNoEntry: false })?.isFile());
  if (missing.length) throw new CliError('map_not_present', `map "${mapId}" is incomplete`, { path: '--map', detail: { devAssets: root, missing } });
}

async function readJsonGz<T>(file: string): Promise<T> {
  const bytes = await readFile(file);
  const plain = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(plain.toString('utf8')) as T;
}

const cache = new Map<string, { identity: string; bundle: Promise<InstalledMapBundle> }>();

/**
 * Load (and memoise) an installed map. The native loader validates the
 * required artifacts and the OpenDRIVE/topology digest pair; the map-intel
 * `derived`/`locations` documents are read beside it for authoring tools.
 */
export function loadMap(mapId: string, root = DEV_ASSETS): Promise<InstalledMapBundle> {
  let dir: string;
  let identity: string;
  try {
    assertKnownMap(mapId, root);
    dir = mapDir(mapId, root);
    identity = REQUIRED_FILES.map((file) => {
      const stat = statSync(path.join(dir, file));
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    }).join('|');
  } catch (error) { return Promise.reject(error); }
  const cached = cache.get(dir);
  if (cached?.identity === identity) return cached.bundle;
  const built = (async (): Promise<InstalledMapBundle> => {
    const native = engine().module.MapBundle.load(dir);
    const [derived, catalog] = await Promise.all([
      readJsonGz<DerivedTopology>(path.join(dir, ARTIFACTS.derived)),
      readJsonGz<LocationCatalog>(path.join(dir, ARTIFACTS.locations)),
    ]);
    return new MapBundle(native, { derived, catalog });
  })().catch((error) => { if (cache.get(dir)?.bundle === built) cache.delete(dir); throw error; });
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(dir, { identity, bundle: built });
  return built;
}

export interface MapBundleSources {
  readonly mapId: string;
  /** Topology index document, or its plain/gzip JSON bytes. */
  readonly topology: TopologyIndex | Uint8Array;
  /** map-intel derived topology; absent → the index is self-derived from the topology. */
  readonly derived?: DerivedTopology;
  /** map-intel location catalog. */
  readonly locations?: LocationCatalog;
  /** `search-index.json` junction control facts. */
  readonly searchIndex?: unknown;
  /** OpenDRIVE text; together with `signalsGeojson` it yields the signal catalog. */
  readonly xodr?: string;
  readonly signalsGeojson?: unknown;
  /** Decoded `colliders` of the static-collider artifact; absent → collision-free map (browser callers fetch it by URL). */
  readonly staticColliders?: readonly StaticMapCollider[];
}

/**
 * Build a bundle from decoded sources without an installed directory. The
 * signal catalog, map speed limits and derived index are derived natively,
 * exactly as `loadMap` does for an installed map.
 *
 * NOT for simulation unless `staticColliders` carries the map's verified
 * colliders: use `createSimulationMapBundle`, which verifies them the way the
 * editor does.
 */
export function createMapBundle(sources: MapBundleSources): MapBundle {
  const { topology, derived, locations, ...rest } = sources;
  const topologyBytes = topology instanceof Uint8Array ? topology : new TextEncoder().encode(JSON.stringify(topology));
  const native = engine().module.MapBundle.fromSources(JSON.stringify({ ...rest, derived, locations }), topologyBytes);
  return new MapBundle(native, { ...(derived ? { derived } : {}), ...(locations ? { catalog: locations } : {}) });
}

/**
 * Read the simulation closure of an installed map directory (the published
 * bundle layout: `map.xodr`, `signals.geojson.gz`, `topology-index.json.gz`,
 * `derived/*`, `3d/manifest.json`, `3d/variants/manifest.json` and the
 * collider artifact it names). `.gz` siblings are accepted for the text files,
 * which is how the golden-trace fixtures are stored.
 */
export async function readInstalledMapClosureFiles(
  dir: string,
  mapId = path.basename(dir),
  options: { readonly closure3dDir?: string } = {},
): Promise<MapClosureFiles> {
  // A map build keeps `3d/*` (web-runtime stage) apart from the master sidecars.
  const threeD = options.closure3dDir ?? dir;
  const plain = async (relative: string): Promise<Uint8Array> => {
    const base = relative.startsWith(`3d${path.sep}`) || relative.startsWith('3d/') ? threeD : dir;
    for (const candidate of [relative, `${relative}.gz`]) {
      const file = path.join(base, candidate);
      if (!existsSync(file)) continue;
      const bytes = await readFile(file);
      return new Uint8Array(bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
    }
    throw new CliError('map_not_present', `map "${mapId}" is missing ${relative}`, { path: dir });
  };
  const derivativeManifest = await plain(path.join('3d', 'variants', 'manifest.json'));
  const variant = (JSON.parse(new TextDecoder().decode(derivativeManifest)) as { variants?: Record<string, { file?: unknown }> })
    .variants?.['static-colliders'];
  if (typeof variant?.file !== 'string') {
    throw new CliError('map_not_present', `map "${mapId}" has no published static-collider derivative`, { path: dir });
  }
  const verdictsFile = path.join(dir, ...AMBIENT_TURN_VERDICTS_PATH.split('/'));
  const shipped = existsSync(verdictsFile) ? await readFile(verdictsFile) : null;
  const ambientTurnVerdicts = shipped ? new Uint8Array(shipped[0] === 0x1f && shipped[1] === 0x8b ? gunzipSync(shipped) : shipped) : null;
  const [topology, derivedTopology, locations, xodr, signals, sourceManifest, artifact] = await Promise.all([
    plain(ARTIFACTS.topology.replace(/\.gz$/, '')),
    plain(ARTIFACTS.derived.replace(/\.gz$/, '')),
    plain(ARTIFACTS.locations.replace(/\.gz$/, '')),
    plain('map.xodr'),
    plain('signals.geojson'),
    plain(path.join('3d', 'manifest.json')),
    plain(path.join('3d', 'variants', variant.file)),
  ]);
  return { mapId, topology, derivedTopology, locations, xodr, signals, colliders: { sourceManifest, derivativeManifest, artifact }, ambientTurnVerdicts };
}

/**
 * The map a SIMULATION runs on, built from its files through the same
 * constructor as the editor (`buildSimulationMapClosure`): verified static
 * colliders included, fail-closed without them. `createMapBundle` stays for
 * non-simulating callers (control plans, matching); a host that simulates
 * must use this, or its traces diverge from the editor's the moment an actor
 * touches map structure. `bundle.closureDigest` is the map part of the
 * simulation key.
 */
export async function createSimulationMapBundle(files: MapClosureFiles): Promise<MapBundle> {
  const graph = await buildSimulationMapClosure<DerivedTopology, LocationCatalog>(engine().module, files);
  const bundle = new MapBundle(graph.bundle, { derived: graph.derived, catalog: graph.locations });
  await restoreAmbientTurnVerdictsFromDisk(bundle);
  return bundle;
}

/**
 * Disk cache of the ambient generator's turn-feasibility verdicts, per map
 * closure and engine semantics:
 * `<SIMFORGE_AMBIENT_TURN_CACHE | map cache>/derived-cache/ambient-turn-verdicts/<engineSemVer>/<closureDigest>.json`.
 * Workers restore it when they build a simulation map (`createSimulationMapBundle`)
 * and persist it after generating ambient traffic, so the probes run once per
 * closure and engine, not once per process. A hit changes timing, never the
 * population (see `EngineRuntime.ambientTurnVerdicts`).
 */
export function ambientTurnVerdictCachePath(bundle: MapBundle): string {
  const root = process.env['SIMFORGE_AMBIENT_TURN_CACHE']
    ?? path.join(path.dirname(DEV_ASSETS), 'derived-cache', 'ambient-turn-verdicts');
  return path.join(root, engine().version().engineSemVer, `${bundle.closureDigest}.json`);
}

const restoredVerdicts = new Map<string, number>();

/** Load this closure's persisted turn verdicts into the addon, once per process. Returns the count. */
export async function restoreAmbientTurnVerdictsFromDisk(bundle: MapBundle): Promise<number> {
  let file: string;
  try { file = ambientTurnVerdictCachePath(bundle); } catch { return 0; }
  const known = restoredVerdicts.get(file);
  if (known !== undefined) return known;
  restoredVerdicts.set(file, 0);
  try {
    const count = engine().loadAmbientTurnVerdicts(await readFile(file, 'utf8'));
    restoredVerdicts.set(file, count);
    return count;
  } catch {
    return 0;
  }
}

/** Write the verdicts the addon holds for this closure when they outgrew the stored table. */
export async function persistAmbientTurnVerdictsToDisk(bundle: MapBundle): Promise<void> {
  try {
    const json = engine().ambientTurnVerdicts(bundle.graph);
    if (!json) return;
    const file = ambientTurnVerdictCachePath(bundle);
    const count = ambientTurnVerdictCount(JSON.parse(json) as AmbientTurnVerdictTable);
    if (count <= (restoredVerdicts.get(file) ?? 0)) return;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, json);
    await rename(temporary, file);
    restoredVerdicts.set(file, count);
  } catch {
    // A read-only cache or a full disk costs only the probes next time.
  }
}

/**
 * Build the map's complete ambient turn-verdict table (every transition, every
 * steered class) and its closure member bytes. A map publish runs this once per
 * `(closureDigest, engineSemVer)` and ships the bytes as
 * `derived/ambient/turn-verdicts.json`; every host that loads the closure then
 * skips the probes. Canonical JSON, so equal inputs give equal bytes.
 */
export function buildAmbientTurnVerdictArtifact(bundle: MapBundle): { bytes: Uint8Array; table: AmbientTurnVerdictTable } {
  const table = engine().buildAmbientTurnVerdicts(bundle.native);
  // Gzipped like the other sidecars (no name or mtime: equal tables, equal bytes).
  return { bytes: new Uint8Array(gzipSync(Buffer.from(`${canonicalJson(table)}\n`), { level: 9 })), table };
}

/**
 * The ambient turn-verdict producer the map pipeline runs in its web-runtime
 * stage (`runMapPipeline({ ambientTurnVerdicts })`): builds the simulation
 * closure from the master sidecars and the stage's colliders, exactly as every
 * simulating host does, then the complete table. Its fingerprint is the engine
 * semantics, so an `ENGINE_SEM_VER` bump rebuilds the table.
 */
export function createAmbientTurnVerdictBuilder(): {
  readonly fingerprint: string;
  build(input: { mapId: string; masterDir: string; runtimeDir: string }): Promise<Uint8Array>;
} {
  return {
    fingerprint: `simforge.ambient-turn-verdicts/v1:${engine().version().engineSemVer}`,
    async build({ mapId, masterDir, runtimeDir }) {
      const bundle = await createSimulationMapBundle(await readInstalledMapClosureFiles(masterDir, mapId, { closure3dDir: runtimeDir }));
      return buildAmbientTurnVerdictArtifact(bundle).bytes;
    },
  };
}

/** `current` when `bytes` is a table for this bundle's closure under this engine, else why not. */
export function ambientTurnVerdictStatus(bundle: MapBundle, bytes: Uint8Array | null): 'current' | 'missing' | 'stale' {
  if (!bytes) return 'missing';
  try {
    const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
    const table = JSON.parse(new TextDecoder().decode(plain)) as Partial<AmbientTurnVerdictTable>;
    return table.schema === 'simforge.ambient-turn-verdicts/v1'
      && table.engineSemVer === engine().version().engineSemVer
      && table.closureDigest === bundle.closureDigest ? 'current' : 'stale';
  } catch {
    return 'stale';
  }
}

/** Resolve `--map` / `--maps` / `--all-maps` into an ordered map id list. */
export function resolveMapSelection(options: {
  map?: string | undefined;
  maps?: readonly string[] | undefined;
  allMaps?: boolean;
}): string[] {
  if (options.allMaps) return availableMaps();
  if (options.maps && options.maps.length > 0) {
    for (const id of options.maps) assertKnownMap(id);
    return [...options.maps];
  }
  if (options.map) {
    assertKnownMap(options.map);
    return [options.map];
  }
  throw new CliError('missing_option', 'one of --map, --maps or --all-maps is required', {
    path: '--map',
  });
}
