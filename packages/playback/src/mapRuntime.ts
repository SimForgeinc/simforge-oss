import { contentHash, type LaneGraph, type NativeMapBundle, type NativeModule } from '@simforge-oss/engine';

import {
  loadStaticMapColliders,
  requireReadyStaticColliderBundle,
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
  const decoder = new TextDecoder();
  const derivedIndex = JSON.parse(decoder.decode(derived)) as Derived;
  const locationCatalog = JSON.parse(decoder.decode(locations)) as Locations;
  const xodrText = decoder.decode(xodr);
  const bundle = options.module.MapBundle.fromSources(JSON.stringify({
    mapId: sources.mapId,
    derived: derivedIndex,
    locations: locationCatalog,
    xodr: xodrText,
    signalsGeojson: JSON.parse(decoder.decode(signals)) as unknown,
    staticColliders: collision.colliders,
  }), topology);
  return {
    bundle,
    graph: bundle.graph,
    collision,
    derived: derivedIndex,
    locations: locationCatalog,
    xodr: xodrText,
  };
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
