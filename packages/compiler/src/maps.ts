/**
 * Map artifacts: discovery and loading of the immutable map corpus.
 *
 * The native compiler reads and validates a map directory (`MapBundle.load`);
 * this module owns the corpus layout (`DEV_ASSETS`), discovery, the memoised
 * `loadMap` and `createMapBundle` for callers that hold map-intel artifacts
 * without an installed directory.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { StaticMapCollider, TopologyIndex } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';
import type { DerivedTopology, LocationCatalog } from '@simforge-oss/maps';

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
 */
export function createMapBundle(sources: MapBundleSources): MapBundle {
  const { topology, derived, locations, ...rest } = sources;
  const topologyBytes = topology instanceof Uint8Array ? topology : new TextEncoder().encode(JSON.stringify(topology));
  const native = engine().module.MapBundle.fromSources(JSON.stringify({ ...rest, derived, locations }), topologyBytes);
  return new MapBundle(native, { ...(derived ? { derived } : {}), ...(locations ? { catalog: locations } : {}) });
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
