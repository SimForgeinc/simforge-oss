import {
  buildSumoRoadOccupancyIndex,
  buildSumoRouteDocument as buildSharedSumoRouteDocument,
  localizeSumoRouteCandidates,
  selectActorCenteredSumoDemand,
  sumoNumericSeed,
  sumoSignalBookIndication,
  synthesizeSumoSignalPrograms,
  validateSumoNetworkManifest,
  validateSumoRuntimeManifest,
  SUMO_DEMAND_ROUTE_OPTIONS,
  SUMO_DEMAND_WARMUP_SECONDS,
  type ControlIndication,
  type ResolvedAmbientTrafficProfile,
  type RoadControl,
  type SignalProgram,
  type SumoNetworkManifest,
  type SumoRuntimeManifest,
  type SumoRoadOccupancyIndex,
} from "@simforge-oss/engine";
import type { ActorView } from "@simforge-oss/viewer";
import type { MapEntry } from "../maps";
import type {
  TrafficNetworkPayload,
  TrafficStepResult,
} from "@simforge-oss/playback";
import {
  fitSumoSignalProgramsToScenario,
  parseSumoSignalTopology,
  type SumoSignalTopology,
} from "@simforge-oss/playback";
import {
  SUMO_RUNTIME_MANIFEST_URL,
  SUMO_RUNTIME_MODULE_URL,
  SUMO_RUNTIME_WASM_URL,
} from "../sumo-runtime";
import { sha256BytesAsync } from "@simforge-oss/engine/hash";

export {
  SUMO_RUNTIME_MANIFEST_URL,
  SUMO_RUNTIME_MODULE_URL,
  SUMO_RUNTIME_WASM_URL,
};
// One demand implementation for the preview and the worker (`@simforge-oss/engine`).
export { localizeSumoRouteCandidates, selectActorCenteredSumoDemand, SUMO_DEMAND_WARMUP_SECONDS };
export type { LocalizedSumoRouteCandidates } from "@simforge-oss/engine";

/**
 * The SimForge signal book the preview's SUMO obeys: the compiled programs
 * and the local trace's recorded phases. With it, preview vehicles stop at
 * the same heads the editor paints — and at the same heads the worker's
 * authoritative traffic stops at.
 */
export interface SumoPreviewSignalBook {
  readonly programs: readonly SignalProgram[];
  readonly roadControls: readonly RoadControl[];
  readonly trace: {
    readonly header: { readonly dt: number; readonly warmupSeconds: number; readonly clipSeconds: number };
    readonly ticks: { readonly signals?: Readonly<Record<string, { readonly phase: readonly ControlIndication[] }>> };
  };
}

export type SumoMapManifest = SumoNetworkManifest & {
  readonly mapVersionId: string;
  readonly sourceMapId: string;
};
export type { SumoRuntimeManifest };

export interface LoadedSumoAssets {
  readonly payload: TrafficNetworkPayload;
  readonly runtime: SumoRuntimeManifest;
  readonly demand: SumoDemandSummary;
  readonly signalTopology: SumoSignalTopology;
  readonly adjustedSignalControllers: number;
  readonly occupancyRoads: SumoRoadOccupancyIndex;
  /** Original map network, retained for deterministic in-worker signal-mode switches. */
  readonly rawNetworkXml: string;
}

export interface SumoDemandFocus {
  readonly x: number;
  readonly z: number;
}
export interface SumoDemandSummary {
  readonly requestedActors: number;
  readonly selectedRoutes: number;
  readonly focus: SumoDemandFocus | null;
  readonly focusCount: number;
  readonly nearbyRouteStarts: number;
  readonly replenishmentPeriodSeconds: number;
  readonly warmupSeconds: number;
}

interface CachedSumoRuntimeAssets {
  readonly runtime: SumoRuntimeManifest;
  readonly wasmBinary: ArrayBuffer;
  readonly wasmModule?: WebAssembly.Module;
}

interface CachedSumoMapAssets {
  readonly manifest: SumoMapManifest;
  readonly networkXml: string;
  readonly signalTopology: SumoSignalTopology;
  readonly occupancyRoads: SumoRoadOccupancyIndex;
}

let cachedRuntimeAssets: CachedSumoRuntimeAssets | null = null;
const cachedMapAssets = new Map<string, CachedSumoMapAssets>();

export async function loadSumoAssets(
  map: MapEntry,
  profile: ResolvedAmbientTrafficProfile,
  fetcher: typeof fetch = fetch,
  focuses: readonly SumoDemandFocus[] = [],
  acceleratedSignalCycles = false,
  signal?: AbortSignal,
  fixedStepSeconds = .05,
  allSignalsGreen = false,
  signalBook?: SumoPreviewSignalBook,
): Promise<LoadedSumoAssets> {
  if (!(fixedStepSeconds > 0) || !Number.isFinite(fixedStepSeconds)) {
    throw new Error("SUMO fixed step must be finite and positive");
  }
  if (!map.sumoManifest || !map.sumoNetworkSha256) {
    throw new Error(`SUMO is not published for ${map.label}`);
  }
  const cacheEnabled = fetcher === globalThis.fetch;
  const mapCacheKey = `${map.mapVersionId}:${map.sourceMapId}:${map.sumoNetworkSha256}`;
  const cachedMap = cacheEnabled ? cachedMapAssets.get(mapCacheKey) : undefined;
  const cachedRuntime = cacheEnabled ? cachedRuntimeAssets : null;
  const request = (input: RequestInfo | URL) =>
    fetcher(input, signal ? { signal } : undefined);
  let runtimeAssets = cachedRuntime;
  let mapAssets = cachedMap;
  if (!runtimeAssets || !mapAssets) {
    const [mapResponse, runtimeResponse, wasmResponse] = await Promise.all([
      request(map.sumoManifest),
      request(SUMO_RUNTIME_MANIFEST_URL),
      request(SUMO_RUNTIME_WASM_URL),
    ]);
    if (!mapResponse.ok)
      throw new Error(
        `SUMO is unavailable for ${map.label} (map sidecar ${mapResponse.status})`,
      );
    if (!runtimeResponse.ok)
      throw new Error(`SUMO runtime is unavailable (${runtimeResponse.status})`);
    if (!wasmResponse.ok)
      throw new Error(
        `SUMO runtime binary is unavailable (${wasmResponse.status})`,
      );
    const manifest = (await mapResponse.json()) as SumoMapManifest;
    const runtime = (await runtimeResponse.json()) as SumoRuntimeManifest;
    // The shared validator owns the logical map slug. Runtime identity is
    // independently bound to the immutable DB version and timestamped source.
    validateSumoNetworkManifest(manifest, manifest.mapId);
    if (manifest.sourceMapId !== map.sourceMapId) {
      throw new Error(
        `SUMO sidecar targets source map ${manifest.sourceMapId}, not ${map.sourceMapId}`,
      );
    }
    if (manifest.sha256 !== map.sumoNetworkSha256) {
      throw new Error(
        `SUMO sidecar network digest does not match map version ${map.mapVersionId}`,
      );
    }
    // A browser-only republish can create a new immutable map-version row
    // without changing the timestamped source map or its SUMO network bytes.
    // The source identity plus verified content digest are the authoritative
    // compatibility boundary; the producing version remains provenance only.
    validateSumoRuntimeManifest(runtime);
    const wasmBinary = validateSumoRuntimeBinary(
      await wasmResponse.arrayBuffer(),
      runtime,
    );
    const manifestUrl = new URL(
      map.sumoManifest,
      globalThis.location?.href ?? "http://localhost/",
    );
    const networkResponse = await request(
      new URL(manifest.networkFile, manifestUrl).toString(),
    );
    if (!networkResponse.ok)
      throw new Error(
        `SUMO network is unavailable for ${map.label} (${networkResponse.status})`,
      );
    const rawNetwork = await networkResponse.arrayBuffer();
    if (rawNetwork.byteLength === 0)
      throw new Error(`SUMO network is empty for ${map.label}`);
    if ((await sha256BytesAsync(rawNetwork)) !== map.sumoNetworkSha256) {
      throw new Error(`SUMO network checksum mismatch for ${map.label}`);
    }
    const networkXml = new TextDecoder().decode(rawNetwork);
    const signalTopology = parseSumoSignalTopology(networkXml);
    // Some published networks retain inactive or internal controlled links
    // without physical-head provenance. SUMO can still simulate those links;
    // the presentation layer simply omits states it cannot bind to a head.
    // WebAssembly.Module is structured-cloneable in modern browsers. Compile
    // while the scenario worker and map are preparing so the traffic worker
    // can instantiate immediately instead of spending ~400 ms compiling after
    // the user presses Play.
    const wasmModule = cacheEnabled ? await WebAssembly.compile(wasmBinary) : undefined;
    runtimeAssets = { runtime, wasmBinary, wasmModule };
    mapAssets = {
      manifest,
      networkXml,
      signalTopology,
      occupancyRoads: buildSumoRoadOccupancyIndex(networkXml, manifest.worldFromNetwork),
    };
    if (cacheEnabled) {
      cachedRuntimeAssets = runtimeAssets;
      cachedMapAssets.set(mapCacheKey, mapAssets);
    }
  }
  const { runtime, wasmBinary, wasmModule } = runtimeAssets;
  const { manifest, networkXml, signalTopology, occupancyRoads } = mapAssets;
  // The SimForge signal book is authoritative. Authors can explicitly opt
  // into a fitted preview cycle (or all-green) without changing link topology.
  const synchronized = signalNetworkForScenario(
    networkXml,
    acceleratedSignalCycles,
    20,
    allSignalsGreen,
    signalBook,
  );
  const network = new TextEncoder().encode(synchronized.xml).buffer;
  const localized = localizeSumoRouteCandidates(
    manifest.routeCandidates,
    networkXml,
    manifest.worldFromNetwork,
    focuses,
  );
  // Reserve most demand for the authored action, some for approaching roads,
  // and a small background share so the visible world still feels connected.
  const demandCandidates = focuses.length > 0
    ? selectActorCenteredSumoDemand(localized, profile.maxActors)
    : localized.candidates;
  const routeDocument = buildSumoRouteDocument(demandCandidates, profile);
  const selectedRoutes = Math.max(
    0,
    Math.min(profile.maxActors, demandCandidates.length),
  );
  return {
    payload: {
      network,
      routes: new TextEncoder().encode(routeDocument).buffer,
      wasmBinary,
      wasmModule,
      seed: sumoNumericSeed(profile.seed),
      stepSeconds: fixedStepSeconds,
      worldFromNetwork: manifest.worldFromNetwork,
      maxActorStates: profile.maxActors,
    },
    runtime,
    demand: {
      requestedActors: profile.maxActors,
      selectedRoutes,
      focus: focuses[0] ?? null,
      focusCount: focuses.length,
      nearbyRouteStarts: localized.nearbyRouteStarts,
      replenishmentPeriodSeconds: SUMO_REPLENISHMENT_PERIOD_SECONDS,
      warmupSeconds: SUMO_DEMAND_WARMUP_SECONDS,
    },
    signalTopology,
    adjustedSignalControllers: synchronized.adjustedControllers,
    occupancyRoads,
    rawNetworkXml: networkXml,
  };
}

export function signalNetworkForScenario(
  networkXml: string,
  acceleratedSignalCycles: boolean,
  scenarioSeconds = 20,
  allSignalsGreen = false,
  signalBook?: SumoPreviewSignalBook,
): { readonly xml: string; readonly adjustedControllers: number } {
  if (signalBook && !acceleratedSignalCycles && !allSignalsGreen) {
    // Same step mapping as the worker: SUMO time 0 is scene time -warmup.
    const preRollSteps = Math.round(SUMO_DEMAND_WARMUP_SECONDS / 0.02);
    const synthesis = synthesizeSumoSignalPrograms(networkXml, signalBook.programs, {
      stepSeconds: 0.02,
      stepCount: preRollSteps + Math.round(signalBook.trace.header.clipSeconds / 0.02) + 1,
      indication: sumoSignalBookIndication({ ...signalBook.trace, header: { ...signalBook.trace.header, dt: 0.02 } }, preRollSteps),
      roadControls: signalBook.roadControls,
    });
    return { xml: synthesis.xml, adjustedControllers: synthesis.report.trafficLights };
  }
  const synchronized = acceleratedSignalCycles
    ? fitSumoSignalProgramsToScenario(networkXml, scenarioSeconds)
    : { xml: networkXml, adjustedControllers: 0 };
  return allSignalsGreen
    ? { ...synchronized, xml: setSumoSignalProgramsAllGreen(synchronized.xml) }
    : synchronized;
}

export function setSumoSignalProgramsAllGreen(networkXml: string): string {
  return networkXml.replace(
    /(<phase\b[^>]*\bstate=")([^"]*)(")/g,
    (_match, prefix: string, state: string, suffix: string) =>
      `${prefix}${"G".repeat(state.length)}${suffix}`,
  );
}

export function validateSumoRuntimeBinary(
  binary: ArrayBuffer,
  runtime: Pick<SumoRuntimeManifest, "wasmBytes">,
): ArrayBuffer {
  if (binary.byteLength !== runtime.wasmBytes) {
    throw new Error(
      `SUMO runtime binary is incomplete (${binary.byteLength}/${runtime.wasmBytes} bytes)`,
    );
  }
  return binary;
}

const SUMO_REPLENISHMENT_PERIOD_SECONDS = SUMO_DEMAND_ROUTE_OPTIONS.replenishmentPeriodSeconds!;

export function buildSumoRouteDocument(
  candidates: readonly (readonly string[])[],
  profile: ResolvedAmbientTrafficProfile,
): string {
  return buildSharedSumoRouteDocument(candidates, profile, SUMO_DEMAND_ROUTE_OPTIONS);
}

export function decodeSumoActorViews(
  result: TrafficStepResult,
  sampleHeight: (x: number, z: number) => number | null,
): readonly ActorView[] {
  const view = new DataView(result.states);
  const actors: ActorView[] = [];
  for (let offset = 0; offset < result.actorCount * 32; offset += 32) {
    const idHash = view.getUint32(offset, true).toString(16).padStart(8, "0");
    const x = view.getFloat32(offset + 4, true);
    const z = view.getFloat32(offset + 8, true);
    const angle = view.getFloat32(offset + 12, true);
    const speed = view.getFloat32(offset + 16, true);
    const signals = view.getUint32(offset + 28, true);
    actors.push({
      id: `sumo:${idHash}`,
      catalogId: "vehicle.sedan",
      catalogIdAuthored: true,
      kind: "car",
      dims: { l: 4.55, w: 1.82, h: 1.48 },
      x,
      y: sampleHeight(x, z) ?? 0,
      z,
      headingRad: normalizeRadians(((angle - 90) * Math.PI) / 180),
      speedMps: speed,
      indicator:
        (signals & 3) === 3
          ? "hazard"
          : (signals & 1) !== 0
            ? "right"
            : (signals & 2) !== 0
              ? "left"
              : "off",
    });
  }
  return actors;
}

function normalizeRadians(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}
