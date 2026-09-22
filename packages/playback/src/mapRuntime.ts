import { contentHash, type LaneGraph, type NativeMapBundle, type NativeModule } from '@simforge-oss/engine';

import {
  loadStaticMapColliders,
  requireReadyStaticColliderBundle,
  verifyStaticColliderArtifact,
  type StaticColliderArtifactSources,
  type StaticColliderBundle,
} from './staticMapColliders';

/** Published artifact URLs a map's native runtime is built from. */
export interface MapGraphSources {
  /** Canonical source map id `MapBundle` is keyed by. */
  readonly mapId: string;
  readonly manifest: string;
  readonly topology: string;
  readonly derivedTopology: string;
  readonly locations: string;
  readonly xodr: string;
  readonly signals: string;
}

/** Pinned per-artifact digests, when the caller has them. */
export interface MapGraphDigests {
  readonly topology?: string;
  readonly derivedTopology?: string;
  readonly locations?: string;
  readonly xodr?: string;
  readonly signals?: string;
}

/**
 * `Derived` and `Locations` are the map-intel artifact shapes the caller's
 * bundle wrapper expects; the builder only parses them and hands them back.
 */
export interface MapGraph<Derived = unknown, Locations = unknown> {
  readonly bundle: NativeMapBundle;
  /** Carries the verified static colliders into every session built on it. */
  readonly graph: LaneGraph;
  readonly collision: StaticColliderBundle;
  readonly derived: Derived;
  readonly locations: Locations;
  readonly xodr: string;
  /**
   * `simforge.map-closure/v1` identity of everything a simulation reads from
   * this map (see `mapClosureDigest`). Part of the simulation key.
   */
  readonly closureDigest: string;
}

/** Decoded bytes of every file a simulated map is built from (gzip already removed). */
export interface MapClosureFiles {
  readonly mapId: string;
  readonly topology: Uint8Array;
  readonly derivedTopology: Uint8Array;
  readonly locations: Uint8Array;
  readonly xodr: Uint8Array;
  readonly signals: Uint8Array;
  /** The published static-collider files; a simulated map without them does not exist. */
  readonly colliders: StaticColliderArtifactSources;
}

/**
 * The identity of a simulated map closure: `simforge.map-closure/v1`, computed
 * by the native bundle over the topology it simulates on (speed limits
 * applied), its static colliders (after the road-boundary rule) and its signal
 * catalog. The WASM and N-API builds report the same value for the same
 * closure, whether it came from published URLs or an installed directory.
 */
export function mapClosureDigest(bundle: NativeMapBundle): string {
  const digest = bundle.closureDigest;
  if (typeof digest !== 'string' || digest.length === 0) {
    throw new Error('This native runtime predates map closure digests (engine 0.8.0); rebuild @simforge-oss/native-runtime');
  }
  return digest;
}

/**
 * Build the simulated world's map from its files. The ONE constructor every
 * simulation host uses, so the editor (via `loadMapGraph`, which fetches the
 * files) and a worker or CLI (which reads them from S3 or disk) simulate
 * against the same closure: same topology, same verified colliders, same
 * signal catalog. Fails closed when the colliders do not verify.
 */
export async function buildSimulationMapClosure<Derived = unknown, Locations = unknown>(
  module: NativeModule,
  files: MapClosureFiles,
  onCollisionLoaded?: (collision: StaticColliderBundle) => void,
): Promise<MapGraph<Derived, Locations>> {
  const collision = requireReadyStaticColliderBundle(await verifyStaticColliderArtifact(files.colliders));
  onCollisionLoaded?.(collision);
  return assembleMapGraph<Derived, Locations>(module, files, collision);
}

function assembleMapGraph<Derived, Locations>(
  module: NativeModule,
  files: Omit<MapClosureFiles, 'colliders'>,
  collision: StaticColliderBundle,
): MapGraph<Derived, Locations> {
  const decoder = new TextDecoder();
  const derivedIndex = JSON.parse(decoder.decode(files.derivedTopology)) as Derived;
  const locationCatalog = JSON.parse(decoder.decode(files.locations)) as Locations;
  const xodrText = decoder.decode(files.xodr);
  const bundle = module.MapBundle.fromSources(JSON.stringify({
    mapId: files.mapId,
    derived: derivedIndex,
    locations: locationCatalog,
    xodr: xodrText,
    signalsGeojson: JSON.parse(decoder.decode(files.signals)) as unknown,
    staticColliders: collision.colliders,
  }), files.topology);
  return {
    bundle,
    graph: bundle.graph,
    collision,
    derived: derivedIndex,
    locations: locationCatalog,
    xodr: xodrText,
    closureDigest: bundle.closureDigest ?? '',
  };
}

async function mapArtifactBytes(url: string, fetcher: typeof fetch, sha256?: string): Promise<Uint8Array> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  if (sha256 && response.headers.get('x-content-sha256') !== sha256) {
    throw new Error(`Map asset identity does not match the pinned digest: ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Map bundles ship sidecars gzipped, and a static file server serves them as
  // opaque bodies with no `Content-Encoding`, so the magic is sniffed rather
  // than the extension or the headers trusted.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decode gzip map artifacts');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The one way a simulated world gets its map.
 *
 * A rendered map is part of the simulated world, not decorative scenery, so
 * this fails closed when the map's immutable collider derivative is missing or
 * fails verification: every session built on the returned graph collides with
 * the map's structures, and no caller can accidentally build a world that does
 * not. Both the editor's scenario worker and the drive session's live world
 * come through here, so there is exactly one collision system.
 */
export async function loadMapGraph<Derived = unknown, Locations = unknown>(options: {
  readonly module: NativeModule;
  readonly sources: MapGraphSources;
  readonly digests?: MapGraphDigests;
  readonly fetcher?: typeof fetch;
  /** Called once the collider artifact is in hand, before the native build. */
  readonly onCollisionLoaded?: (collision: StaticColliderBundle) => void;
}): Promise<MapGraph<Derived, Locations>> {
  const fetcher = options.fetcher ?? fetch;
  const { sources, digests } = options;
  const [topology, derived, locations, xodr, signals] = await Promise.all([
    mapArtifactBytes(sources.topology, fetcher, digests?.topology),
    mapArtifactBytes(sources.derivedTopology, fetcher, digests?.derivedTopology),
    mapArtifactBytes(sources.locations, fetcher, digests?.locations),
    mapArtifactBytes(sources.xodr, fetcher, digests?.xodr),
    mapArtifactBytes(sources.signals, fetcher, digests?.signals),
  ]);
  const collision = requireReadyStaticColliderBundle(await loadStaticMapColliders(sources.manifest, fetcher));
  options.onCollisionLoaded?.(collision);
  return assembleMapGraph<Derived, Locations>(options.module, {
    mapId: sources.mapId,
    topology,
    derivedTopology: derived,
    locations,
    xodr,
    signals,
  }, collision);
}

export interface MapRuntimeIdentity {
  /** Canonical source map id used by MapBundle, replay and simulation input. */
  readonly mapId: string;
  readonly assetDigest: string;
  readonly graphDigest: string;
  readonly controlDigest: string;
  readonly colliderDigest: string;
}

export interface CompileIdentity {
  readonly revision: string;
  readonly documentDigest: string;
  readonly ambientDigest: string;
}

/**
 * Stable identity for the files from which a worker-side map runtime is built.
 * Map assets use content-addressed URLs in production; tests and development
 * can supply an explicit revision by changing any URL.
 */
export function mapAssetDigest(map: {
  readonly id?: string;
  readonly runtimeAssetId?: string;
  readonly mapVersionId?: string;
  readonly sourceMapId?: string;
  readonly browserClosureSha256?: string;
  readonly manifest: string;
  readonly topology: string;
  readonly derivedTopology: string;
  readonly locations: string;
  readonly xodr: string;
  readonly signals: string;
}): string {
  if (!map.id && !map.runtimeAssetId) {
    throw new Error('mapAssetDigest requires a local id or immutable runtimeAssetId');
  }
  return contentHash(map);
}

export function runtimeDigest(identity: MapRuntimeIdentity): string {
  return contentHash(identity);
}

export function compileDigest(runtime: MapRuntimeIdentity, compile: CompileIdentity): string {
  return contentHash({ runtime: runtimeDigest(runtime), compile });
}

/** Only these jobs may create complete traces or interchange/evidence output. */
export type RuntimeJobKind = 'compile' | 'play' | 'validate' | 'export' | 'robustness';

export function jobProducesCompleteTrace(kind: RuntimeJobKind): boolean {
  return kind === 'validate' || kind === 'export' || kind === 'robustness';
}

export function jobProducesArtifacts(kind: RuntimeJobKind): boolean {
  return kind === 'export';
}

/** Main-thread revision gate. A superseded worker response is never installable. */
export class RevisionGate {
  private current = '';

  begin(revision: string): void {
    this.current = revision;
  }

  accepts(revision: string): boolean {
    return revision === this.current;
  }

  invalidate(): void {
    this.current = '';
  }
}
