/**
 * `MapBundle` — the compiler's view of one loaded map.
 *
 * The native bundle (`simforge-compiler::bundle::MapBundle`) owns the lane
 * graph, the normalised derived index, the signal catalog and the static
 * colliders; every compile, match and simulation call takes it by handle. The
 * decoded documents beside it (`topology`, `index`, `signalCatalog`, plus the
 * map-intel `catalog`/`derived` artifacts when the loader had them) are
 * read-only views for authoring tools and are decoded lazily from the native
 * bundle — never re-derived in TypeScript.
 */

import type { LaneGraph, NativeMapBundle, NativeSite, TopologyIndex } from '@simforge-oss/engine';
import type { DerivedTopology, LocationCatalog } from '@simforge-oss/maps';
import { guard } from '@simforge-oss/native-runtime/shared';

import type { DerivedMapIndex } from './anchor/index.js';
import type { MapControlPlan, MapSignalCatalog, SignalControlIndex, SiteSignalPlan, SiteSignalRef } from './map-signals.js';

export interface MapBundleArtifacts {
  /** `derived/locations.json.gz` (map-intel), when supplied. */
  readonly catalog?: LocationCatalog;
  /** `derived/topology-derived.json.gz` (map-intel), when supplied. */
  readonly derived?: DerivedTopology;
}

/** A bundle whose loader read both map-intel artifacts — every installed map. */
export type InstalledMapBundle = MapBundle<Required<MapBundleArtifacts>>;

export class MapBundle<A extends MapBundleArtifacts = MapBundleArtifacts> {
  readonly mapId: string;
  /** The engine's view — the native lane graph shared by every session built here. */
  readonly graph: LaneGraph;
  private topologyCache: TopologyIndex | null = null;
  private indexCache: DerivedMapIndex | null = null;
  private signalCatalogCache: MapSignalCatalog | null = null;

  constructor(readonly native: NativeMapBundle, readonly artifacts: A = {} as A) {
    this.mapId = native.mapId;
    this.graph = native.graph;
  }

  /** `source.xodrSha256` of the topology; the digest written into traces and site ids. */
  get digest(): string {
    return this.native.digest;
  }

  /** The topology index with map speed limits applied, as the native bundle holds it. */
  get topology(): TopologyIndex {
    if (!this.topologyCache) this.topologyCache = JSON.parse(guard(() => this.native.topologyJson())) as TopologyIndex;
    return this.topologyCache;
  }

  /** The matcher's view — derived facts adopted from map-intel, normalised natively. */
  get index(): DerivedMapIndex {
    if (!this.indexCache) this.indexCache = JSON.parse(guard(() => this.native.indexJson())) as DerivedMapIndex;
    return this.indexCache;
  }

  /** Physical heads + OpenDRIVE controller/junction sequence bindings. */
  get signalCatalog(): MapSignalCatalog {
    if (!this.signalCatalogCache) this.signalCatalogCache = JSON.parse(guard(() => this.native.signalCatalogJson())) as MapSignalCatalog;
    return this.signalCatalogCache;
  }

  /** map-intel location catalog when the loader supplied it. */
  get catalog(): A['catalog'] {
    return this.artifacts.catalog;
  }

  /** map-intel derived topology when the loader supplied it. */
  get derived(): A['derived'] {
    return this.artifacts.derived;
  }

  /** Every physical signalised junction and stop control on the map, bound to engine programs. */
  controlPlan(): MapControlPlan {
    return JSON.parse(guard(() => this.native.controlPlanJson())) as MapControlPlan;
  }

  /** Exact head/movement/controller/junction reverse indices of {@link controlPlan}. */
  signalControlIndex(): SignalControlIndex {
    return JSON.parse(guard(() => this.native.signalControlIndexJson())) as SignalControlIndex;
  }

  /** The signal programs a matched site's junction executes, bound to physical heads. */
  siteSignalPlan(site: NativeSite): SiteSignalPlan {
    return JSON.parse(guard(() => this.native.siteSignalPlanJson(site))) as SiteSignalPlan;
  }

  /** The program id an authored signal reference resolves to at `site`; stable-sorted tie-break, never insertion order. */
  resolveSiteSignalProgram(site: NativeSite, ref: SiteSignalRef): string | null {
    return guard(() => this.native.resolveSiteSignalProgram(site, JSON.stringify(ref)));
  }
}
