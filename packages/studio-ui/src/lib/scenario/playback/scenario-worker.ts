/// <reference lib="webworker" />

/* eslint-disable @typescript-eslint/no-explicit-any */

import { exportOpenScenarioXml14 } from '@simforge-oss/openscenario';
import { AsamExportError } from '@simforge-oss/openscenario';
import {
  MapBundle,
  adaptTemplateNotesWith,
  compileTemplateWith,
  materializationSemanticLosses,
  matchSitesWith,
  withParkedCarActors,
  withStudioBodyColorTags,
  type MapControlPlan,
} from '@simforge-oss/compiler';
import { parkedCarsFromExtensions } from '../parking/extension';
import {
  contentHash,
  pruneDanglingAfterInteractions,
  parseSimScenarioInput,
  type AmbientTrafficProfile,
  type AmbientTrafficProvenance,
  type AmbientTrafficResult,
  type EngineRuntime,
  type EvaluateFilters,
  type IntentRubricInput,
  type LaneGraph,
  type SimScenarioInput,
  type SimResult,
  type SimTrace,
  type SimulationHandle,
} from '@simforge-oss/engine';
import { loadEngine } from '@simforge-oss/engine/browser';
import type { ScenarioTemplateV2 } from '@simforge-oss/scenario';
import { registerExternalCatalogEntry, type ExternalCatalogEntry } from '@simforge-oss/asset-catalog';
import { ambientRobustnessGate, evaluateAmbientRobustness } from '@simforge-oss/playback/traffic';
import type { OpenScenarioSnapshot, OpenScenarioSourceMapping } from '@simforge-oss/openscenario';
import {
  initialLiveTickBudget,
  loadStaticMapColliders,
  mapAssetDigest,
  planLiveRefill,
  requireReadyStaticColliderBundle,
  runCanonicalPreview,
  runtimeDigest,
  selectPlayableSite,
  withBoundedSpeedCruiseRestoration,
  withEditablePhysicsDefault,
  withStableHighSpeedWorldRoutes,
  type MapRuntimeIdentity,
  type StaticColliderDiagnostics,
} from '@simforge-oss/playback';

export interface ScenarioWorkerMap {
  /** Immutable browser asset/cache identity. Never used as semantic mapId. */
  runtimeAssetId: string;
  mapVersionId: string;
  sourceMapId: string;
  browserClosureSha256: string;
  manifest: string;
  topology: string;
  derivedTopology: string;
  locations: string;
  xodr: string;
  signals: string;
  /** Published digests of the served bytes, so the page cache admits each file under its exact identity. */
  digests?: {
    readonly topology: string;
    readonly derivedTopology: string;
    readonly locations: string;
    readonly xodr: string;
    readonly signals: string;
  };
}

export interface ScenarioWorkerRequest {
  kind?: 'compile' | 'export' | 'robustness';
  id: number;
  /** The editor revision that must be echoed back unchanged. */
  revision?: string;
  template: ScenarioTemplateV2;
  map: ScenarioWorkerMap;
  ambientTraffic: AmbientTrafficProfile;
  /** Validated concrete authored evidence used as the immutable base for an editable world. */
  baseInstance?: {
    readonly manifest: Record<string, unknown>;
    readonly input: SimScenarioInput;
  };
  operation?: 'prepare' | 'materialize' | 'robustness';
  evaluationFilters?: EvaluateFilters;
  /** Optional canonical intent rubric. Without it robustness is incomplete, never accepted. */
  intentRubric?: IntentRubricInput;
  /**
   * Every runtime catalog entry registered on the main thread: gallery uploads
   * and CARLA objects. The worker holds a separate module instance of the
   * catalog, so an unshared entry materialises as an unknown id.
   */
  externalCatalog?: readonly ExternalCatalogEntry[];
}

export interface ScenarioWorkerStartRequest {
  readonly kind: 'start';
  readonly id: number;
  readonly revision: string;
  readonly runtimeKey: string;
  readonly input: SimScenarioInput;
  readonly externalCatalog?: readonly ExternalCatalogEntry[];
}
export interface ScenarioWorkerCancelRequest {
  readonly kind: 'cancel';
  readonly id?: number;
  readonly externalCatalog?: readonly ExternalCatalogEntry[];
}
export interface ScenarioWorkerTransportRequest {
  readonly kind: 'transport';
  readonly id: number;
  readonly playing: boolean;
  /** Authoritative display playhead, including seeks. */
  readonly time?: number;
  readonly externalCatalog?: readonly ExternalCatalogEntry[];
}
/** Identity of the loaded native engine, without compiling anything. */
export interface ScenarioWorkerEngineRequest {
  readonly kind: 'engine';
  readonly id: number;
  readonly externalCatalog?: readonly ExternalCatalogEntry[];
}
/** Main-thread answer to a {@link ScenarioWorkerAssetRequest}. */
export interface ScenarioWorkerAssetResponse {
  readonly kind: 'asset';
  readonly resolveId: number;
  readonly url?: string;
  readonly error?: string;
  readonly externalCatalog?: readonly ExternalCatalogEntry[];
}
export type ScenarioWorkerMessage = ScenarioWorkerRequest | ScenarioWorkerStartRequest | ScenarioWorkerCancelRequest | ScenarioWorkerTransportRequest | ScenarioWorkerEngineRequest | ScenarioWorkerAssetResponse;

/** The engine build that executes every browser trace; persisted previews are admitted only against it. */
export interface ScenarioWorkerEngineIdentity {
  readonly engineVersion: string;
  readonly abiVersion: number;
}

export interface AmbientRobustnessSummary {
  readonly version: 1;
  readonly baseInputHash: string;
  readonly baselineVerdict: string;
  readonly accepted: boolean;
  readonly overall: 'accepted' | 'rejected' | 'incomplete';
  readonly intent: {
    readonly status: 'evaluated' | 'not_evaluated';
    readonly baselineVerdict: 'accept' | 'reject' | null;
    readonly caseVerdicts: Readonly<Record<string, 'accept' | 'reject'>>;
  };
  readonly filters: EvaluateFilters;
  readonly cases: readonly {
    label: string;
    accepted: boolean;
    deterministic: boolean;
    authoredEventOrderPreserved: boolean;
    authoredNeverFiredPreserved: boolean;
    ambientCollisions: number;
    runtimeMs: number;
    generatedActors: number;
    profileHash: string;
    verdict: string;
    failures: readonly string[];
    warnings: readonly string[];
  }[];
}

export type ScenarioWorkerResponse =
  | { id: number; revision: string; ok: true; kind: 'prepare-progress'; phase: 'map-assets' | 'map-collisions' | 'simulation' }
  | { id: number; revision: string; ok: true; kind: 'prepare'; runtimeKey: string; cache: 'cold' | 'warm'; timing?: { totalMs: number; compileCache: 'hit' | 'miss' }; instance: unknown; trace: SimTrace; siteId: string; ambientTraffic: AmbientTrafficProvenance; openScenario?: OpenScenarioSnapshot; mapCollisions: StaticColliderDiagnostics }
  | { id: number; revision: string; ok: true; kind: 'robustness'; report: AmbientRobustnessSummary }
  | { id: number; revision: string; ok: true; kind: 'ready' | 'progress' | 'complete'; trace: SimTrace; recordedUntil: number }
  | { id: number; revision: string; ok: true; kind: 'engine'; engine: ScenarioWorkerEngineIdentity }
  | { id: number; revision: string; ok: false; error: string };

/**
 * Worker-to-page request to resolve one immutable map asset URL through the
 * page's map-asset cache. A worker's own `fetch` sees neither the browser
 * gateway nor the desktop filesystem bridge, so without this every map runtime
 * load would go to the network even when the verified bytes are already local.
 */
export interface ScenarioWorkerAssetRequest {
  readonly kind: 'resolve-asset';
  readonly resolveId: number;
  readonly url: string;
  readonly sha256?: string;
}
export type ScenarioWorkerOutbound = ScenarioWorkerResponse | ScenarioWorkerAssetRequest;

/**
 * One loaded map: the native bundle (lane graph, derived index, signal
 * catalog and the verified static colliders every simulation over `graph`
 * collides against), the map-wide control plan and the OpenDRIVE text.
 */
interface MapRuntime {
  readonly key: string;
  readonly identity: MapRuntimeIdentity;
  readonly graph: LaneGraph;
  readonly bundle: MapBundle;
  readonly controls: MapControlPlan;
  readonly xodr: string;
  readonly mapCollisions: StaticColliderDiagnostics;
}

// Map runtimes and compiled worlds are keyed by immutable content, so a hit is
// exact. Both are bounded: an editing session produces one compiled world per
// edit (each holding a complete trace) and a dataset browse touches many maps
// (each holding decoded topology, XODR text and the native bundle). The bounds
// keep A/B/A map switches and undo/redo warm without growing with session length.
const MAP_RUNTIME_LIMIT = 3;
const COMPILED_WORLD_LIMIT = 8;
const runtimesByAsset = new Map<string, Promise<MapRuntime>>();
const runtimesByKey = new Map<string, MapRuntime>();
const compiledWorlds = new Map<string, Promise<ScenarioWorkerResponse>>();
// Interactive compilation already advances the canonical engine through
// warmup to produce t=0. Hand that exact world to Play once, avoiding a
// second warmup pass over all dynamic actors.
const preparedLiveSessions = new Map<string, SimulationHandle>();
let liveGeneration = 0;
let transport: {
  id: number;
  playing: boolean;
  playheadS: number;
  wallStartedMs: number | null;
  wake: (() => void) | null;
} | null = null;

const scope = self as unknown as DedicatedWorkerGlobalScope;

const pendingAssets = new Map<number, { resolve: (url: string) => void; reject: (reason: Error) => void }>();
let assetSequence = 0;

/** Ask the page where the verified bytes of one immutable asset live. */
function resolveAssetUrl(url: string, sha256?: string): Promise<string> {
  const resolveId = ++assetSequence;
  return new Promise<string>((resolve, reject) => {
    pendingAssets.set(resolveId, { resolve, reject });
    scope.postMessage({ kind: 'resolve-asset', resolveId, url, ...(sha256 ? { sha256 } : {}) } satisfies ScenarioWorkerAssetRequest);
  });
}

/** `fetch` whose URL is first resolved by the page to wherever its verified bytes live. */
const cachedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return fetch(await resolveAssetUrl(url), init);
};

scope.onmessage = (event: MessageEvent<ScenarioWorkerMessage>): void => {
  const request = event.data;
  // The worker holds its own module instance of the prop catalog, so gallery
  // entries registered on the main thread are invisible here. Without this the
  // materializer reports the id as unknown and substitutes a default model.
  for (const entry of request.externalCatalog ?? []) registerExternalCatalogEntry(entry);
  if (request.kind === 'asset') {
    const pending = pendingAssets.get(request.resolveId);
    pendingAssets.delete(request.resolveId);
    if (!pending) return;
    if (request.url) pending.resolve(request.url);
    else pending.reject(new Error(request.error ?? 'Map asset could not be resolved'));
    return;
  }
  if (request.kind === 'cancel') {
    liveGeneration += 1;
    transport?.wake?.();
    transport = null;
    return;
  }
  if (request.kind === 'transport') {
    if (transport?.id !== request.id) return;
    const now = performance.now();
    if (typeof request.time === 'number') {
      transport.playheadS = Math.max(0, request.time);
    } else if (transport.playing && transport.wallStartedMs !== null) {
      transport.playheadS += Math.max(0, now - transport.wallStartedMs) / 1000;
    }
    transport.playing = request.playing;
    transport.wallStartedMs = request.playing ? now : null;
    transport.wake?.();
    transport.wake = null;
    return;
  }
  if (request.kind === 'start') {
    const token = ++liveGeneration;
    transport = { id: request.id, playing: false, playheadS: 0, wallStartedMs: null, wake: null };
    void runLive(request, token).catch((reason: unknown) => postFailure(request.id, request.revision, reason));
    return;
  }
  if (request.kind === 'engine') {
    void loadEngine().then(
      (engine) => scope.postMessage({ id: request.id, revision: '', ok: true, kind: 'engine', engine: engine.version() } satisfies ScenarioWorkerResponse),
      (reason: unknown) => postFailure(request.id, '', reason),
    );
    return;
  }
  postPrepareProgress(request, 'map-assets');
  void prepare(request).then(
    (response) => scope.postMessage(response),
    (reason: unknown) => postFailure(request.id, request.revision ?? String(request.id), reason),
  );
};

async function prepare(request: ScenarioWorkerRequest): Promise<ScenarioWorkerResponse> {
  const interactive = request.kind === 'compile' || request.operation === 'materialize';
  if (!interactive) return prepareUncached(request);
  const started = performance.now();
  const revision = request.revision ?? String(request.id);
  const key = contentHash({
    map: mapAssetDigest(request.map),
    revision,
    document: request.template,
    ambient: request.ambientTraffic,
    base: request.baseInstance?.input ?? null,
  });
  const cached = compiledWorlds.get(key);
  if (cached) {
    // Re-insert so the most recently used world is evicted last.
    compiledWorlds.delete(key);
    compiledWorlds.set(key, cached);
    const response = await cached;
    return response.ok && response.kind === 'prepare'
      ? { ...response, id: request.id, revision, cache: 'warm', timing: { totalMs: performance.now() - started, compileCache: 'hit' } }
      : response;
  }
  const pending = prepareUncached(request);
  compiledWorlds.set(key, pending);
  while (compiledWorlds.size > COMPILED_WORLD_LIMIT) compiledWorlds.delete(compiledWorlds.keys().next().value!);
  try {
    const response = await pending;
    return response.ok && response.kind === 'prepare'
      ? { ...response, timing: { totalMs: performance.now() - started, compileCache: 'miss' } }
      : response;
  } catch (error) {
    compiledWorlds.delete(key);
    throw error;
  }
}

async function prepareUncached(request: ScenarioWorkerRequest): Promise<ScenarioWorkerResponse> {
  const assetKey = mapAssetDigest(request.map);
  const cache = runtimesByAsset.has(assetKey) ? 'warm' : 'cold';
  const engine = await loadEngine();
  const runtime = await getMapRuntime(engine, request.map, request);
  const { graph, bundle, controls: mapControls, xodr, mapCollisions } = runtime;
  const isInteractiveCompile = request.kind === 'compile' || request.operation === 'materialize';
  const revision = request.revision ?? String(request.id);

  // A blank editor still owns one normal concrete world. It has no authored
  // rows yet, but its ambient SimActors use the same routes, controls, physics,
  // collision handling and trace format as every later authored scenario.
  if (request.template.roles.length === 0 && !request.baseInstance) {
    // Parked cars belong here too, so they do not blink out of the preview the
    // moment the last authored actor is deleted.
    const base = withParkedCarActors(
      withMapControls(withEditablePhysicsDefault(createEmptyAmbientInput(request.map.sourceMapId)), mapControls),
      parkedCarsFromExtensions(request.template.extensions).baked,
    );
    const populated = applyRequestedAmbientPopulation(engine, base, graph, request);
    // The core schema requires one actor. Keep a remote, non-render-authoritative
    // clock only when an external provider (SUMO) owns the entire visible
    // population; remove it as soon as native ambient actors exist.
    const ambient = populated.provenance.actors.length === 0 ? populated : {
      ...populated,
      input: { ...populated.input, actors: populated.input.actors.filter((actor) => actor.id !== 'ambient-world-seed') },
    };
    const result = simulateForRequest(engine, ambient.input, graph, request.operation, request);
    const manifest = {
      instanceId: `ambient-world:${request.map.sourceMapId}`,
      inputHash: contentHash(base),
      replayKey: { mapId: request.map.sourceMapId, engineGraphDigest: graph.digest, siteId: 'ambient-world' },
      actors: [],
    };
    return {
      id: request.id,
      revision,
      ok: true,
      kind: 'prepare',
      runtimeKey: runtime.key,
      cache,
      instance: ambientInstance(manifest, result.input, ambient.provenance, result.issues),
      trace: result.trace,
      siteId: 'ambient-world',
      ambientTraffic: ambient.provenance,
      mapCollisions,
    };
  }

  if (request.baseInstance) {
    if (request.baseInstance.input.mapId !== request.map.sourceMapId) {
      throw new Error(`Verified base targets ${request.baseInstance.input.mapId}, not ${request.map.sourceMapId}`);
    }
    // A verified bundle is replayed directly elsewhere. Reaching the worker
    // means the user requested a regenerated editable simulation: deterministically
    // migrate an unpinned legacy input to the current dynamic authoring default.
    const repaired = pruneDanglingAfterInteractions(request.baseInstance.input.interactions);
    const editableInput = withParkedCarActors(withStudioBodyColorTags(withMapControls(withEditablePhysicsDefault({
      ...request.baseInstance.input,
      // Parked cars are regenerated from the document like ambient traffic is,
      // so a stale bake never outlives the extension that produced it.
      actors: request.baseInstance.input.actors.filter(
        (actor) => !isAmbientSimActor(actor) && !isParkedSimActor(actor),
      ),
      interactions: repaired.interactions,
    }), mapControls), request.template), parkedCarsFromExtensions(request.template.extensions).baked);
    const generated = applyRequestedAmbientPopulation(engine, editableInput, graph, request);
    const ambient = repaired.removed.length === 0 ? generated : {
      ...generated,
      provenance: {
        ...generated.provenance,
        warnings: [
          ...generated.provenance.warnings,
          ...repaired.removed.map((item) => `Removed stale concrete command ${item.interactionId}: after(${item.missingInteractionId}) has no source interaction.`),
        ],
      },
    };
    const result = simulateForRequest(engine, ambient.input, graph, request.operation, request);
    const instance = ambientInstance(request.baseInstance.manifest, result.input, ambient.provenance, result.issues);
    const replayKey = request.baseInstance.manifest['replayKey'] as Record<string, unknown> | undefined;
    return {
      id: request.id,
      revision,
      ok: true,
      kind: 'prepare',
      runtimeKey: runtime.key,
      cache,
      instance,
      trace: result.trace,
      siteId: String(replayKey?.['siteId'] ?? 'verified-base'),
      ambientTraffic: ambient.provenance,
      mapCollisions,
      ...(isInteractiveCompile ? {} : { openScenario: createOpenScenarioSnapshot(engine, request.template, instance, result.input, result.trace, graph, xodr) }),
    };
  }

  const isMapBound = request.template.roles.length > 0 && request.template.roles.every((role) => role.kind === 'scene_absolute');
  if (isMapBound) {
    // Map-bound documents skip matching: the native compiler binds them at their pinned site.
    const product = compileTemplateWith(engine.module, request.template, bundle, null, { drawIndex: -1 });
    if (!product.manifest.feasible) {
      const errors = product.manifest.issues.filter((issue) => issue.severity === 'error');
      throw new Error(`Scenario is not feasible: ${errors.map((issue) => issue.reason).join(' · ')}`);
    }
    const controlledInput = withParkedCarActors(
      withStudioBodyColorTags(withMapControls(product.input, mapControls), request.template),
      parkedCarsFromExtensions(request.template.extensions).baked,
    );
    const ambient = applyRequestedAmbientPopulation(engine, controlledInput, graph, request);
    if (request.operation === 'robustness') return robustnessResponse(engine, request, controlledInput, graph);
    const result = simulateForRequest(engine, ambient.input, graph, request.operation, request);
    const instance = ambientInstance(product.manifest, result.input, ambient.provenance, result.issues);
    return {
      id: request.id,
      revision,
      ok: true,
      kind: 'prepare',
      runtimeKey: runtime.key,
      cache,
      instance,
      trace: result.trace,
      siteId: product.manifest.replayKey.siteId,
      ambientTraffic: ambient.provenance,
      mapCollisions,
      ...(isInteractiveCompile ? {} : { openScenario: createOpenScenarioSnapshot(engine, request.template, instance, result.input, result.trace, graph, xodr) }),
    };
  }

  const notes = adaptTemplateNotesWith(engine.module, request.template);
  if (notes.length > 0) {
    throw new Error(`Scenario uses constructs the matcher cannot preserve: ${notes.map((note) => `${note.path}: ${note.reason}`).join(' · ')}`);
  }
  const { report } = matchSitesWith(engine.module, request.template, bundle);
  if (!report.sites.some((candidate) => candidate.degradation.intentPreserved)) {
    throw new Error(`No intent-preserving site matches this scenario on ${request.map.sourceMapId}${report.failureSummary ? ` (${report.failureSummary})` : ''}`);
  }
  const selected = selectPlayableSite(report.sites, (candidate) => {
    const candidateProduct = compileTemplateWith(engine.module, request.template, bundle, candidate, { drawIndex: -1 });
    const semanticLosses = materializationSemanticLosses(candidateProduct.manifest.notes);
    if (semanticLosses.length > 0) {
      throw new Error(`materialization would lose authored semantics: ${semanticLosses.map((note) => `${note.path}: ${note.reason}`).join(' · ')}`);
    }
    if (!candidateProduct.manifest.feasible) {
      const errors = candidateProduct.manifest.issues.filter((issue) => issue.severity === 'error');
      throw new Error(`scenario is not feasible: ${errors.map((issue) => issue.reason).join(' · ')}`);
    }
    return candidateProduct;
  });
  const { site, product } = selected;
  const controlledInput = withStudioBodyColorTags(withMapControls(product.input, mapControls), request.template);
  const ambient = applyRequestedAmbientPopulation(engine, controlledInput, graph, request);
  if (request.operation === 'robustness') return robustnessResponse(engine, request, controlledInput, graph);
  const result = simulateForRequest(engine, ambient.input, graph, request.operation, request);
  const instance = ambientInstance(product.manifest, result.input, ambient.provenance, result.issues);
  return {
    id: request.id,
    revision,
    ok: true,
    kind: 'prepare',
    runtimeKey: runtime.key,
    cache,
    instance,
    trace: result.trace,
    siteId: site.siteId,
    ambientTraffic: ambient.provenance,
    mapCollisions,
    ...(isInteractiveCompile ? {} : { openScenario: createOpenScenarioSnapshot(engine, request.template, instance, result.input, result.trace, graph, xodr) }),
  };
}

/** Empty authored document base. Ambient actors are ordinary runtime actors added afterward. */
function createEmptyAmbientInput(mapId: string): SimScenarioInput {
  const parsed = parseSimScenarioInput({
    mapId,
    clipSeconds: 20,
    warmupSeconds: 0,
    dt: 0.05,
    seed: `ambient-world:${mapId}`,
    actors: [{
      id: 'ambient-world-seed',
      kind: 'static_object',
      static: true,
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
      behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } },
      tags: ['ambient:internal-clock'],
    }],
    physics: { mode: 'dynamic-v1' },
  });
  return parsed;
}

async function getMapRuntime(engine: EngineRuntime, map: ScenarioWorkerMap, request: ScenarioWorkerRequest): Promise<MapRuntime> {
  if (map.runtimeAssetId !== map.mapVersionId) {
    throw new Error(`Map runtime identity ${map.runtimeAssetId} does not match immutable version ${map.mapVersionId}`);
  }
  const assetDigest = mapAssetDigest(map);
  const existing = runtimesByAsset.get(assetDigest);
  if (existing) {
    runtimesByAsset.delete(assetDigest);
    runtimesByAsset.set(assetDigest, existing);
    return existing;
  }
  const pending = (async (): Promise<MapRuntime> => {
    const [topology, derived, locations, xodr, signals] = await Promise.all([
      fetchBytes(map.topology, map.digests?.topology),
      fetchJson(map.derivedTopology, map.digests?.derivedTopology),
      fetchJson(map.locations, map.digests?.locations),
      fetchText(map.xodr, map.digests?.xodr),
      fetchJson(map.signals, map.digests?.signals),
    ]);
    // A rendered map is part of the simulated world, not decorative scenery.
    // Fail closed when its immutable collider derivative is unavailable so an
    // editor preview can never present cars passing through visible structures.
    postPrepareProgress(request, 'map-collisions');
    const staticCollision = requireReadyStaticColliderBundle(await loadStaticMapColliders(map.manifest, cachedFetch));
    // The native bundle derives the signal catalog, map speed limits and the
    // matcher index exactly as the installed-map loader does, and its lane
    // graph carries the verified colliders into every simulation built on it.
    const bundle = new MapBundle(engine.module.MapBundle.fromSources(JSON.stringify({
      mapId: map.sourceMapId,
      derived,
      locations,
      xodr,
      signalsGeojson: signals,
      staticColliders: staticCollision.colliders,
    }), topology), { derived, catalog: locations });
    const graph = bundle.graph;
    const controls = bundle.controlPlan();
    const identity: MapRuntimeIdentity = {
      mapId: map.sourceMapId,
      assetDigest,
      graphDigest: graph.digest,
      controlDigest: contentHash(controls),
      colliderDigest: staticCollision.diagnostics.digest,
    };
    const runtime: MapRuntime = {
      key: runtimeDigest(identity), identity, graph, bundle, controls, xodr,
      mapCollisions: staticCollision.diagnostics,
    };
    runtimesByKey.set(runtime.key, runtime);
    return runtime;
  })();
  runtimesByAsset.set(assetDigest, pending);
  try {
    const runtime = await pending;
    while (runtimesByAsset.size > MAP_RUNTIME_LIMIT) {
      const [evictedDigest, evicted] = runtimesByAsset.entries().next().value!;
      runtimesByAsset.delete(evictedDigest);
      void evicted.then((stale) => runtimesByKey.delete(stale.key), () => undefined);
    }
    return runtime;
  } catch (error) {
    runtimesByAsset.delete(assetDigest);
    throw error;
  }
}

async function runLive(request: ScenarioWorkerStartRequest, token: number): Promise<void> {
  const runtime = runtimesByKey.get(request.runtimeKey);
  if (!runtime) throw new Error('The compiled map runtime is no longer available; compile this revision again.');
  const inputKey = contentHash(request.input);
  const prepared = preparedLiveSessions.get(inputKey);
  if (prepared) preparedLiveSessions.delete(inputKey);
  const engine = await loadEngine();
  const simulation = prepared ?? engine.simulation(request.input, { graph: runtime.graph });
  let progress = advanceLive(simulation, prepared ? 1 : initialLiveTickBudget(request.input.warmupSeconds, request.input.dt));
  postLive(request, progress.done ? 'complete' : 'ready', progress.trace, progress.recordedUntil);
  while (!progress.done && token === liveGeneration) {
    await waitUntilPlaying(request.id, token);
    if (transport?.id === request.id && !transport.playing) continue;
    if (token !== liveGeneration) return;
    const activeTransport = transport;
    if (!activeTransport || activeTransport.id !== request.id) return;
    const playhead = activeTransport.playheadS + (activeTransport.wallStartedMs === null
      ? 0
      : Math.max(0, performance.now() - activeTransport.wallStartedMs) / 1000);
    const refill = planLiveRefill(progress.recordedUntil, playhead, request.input.dt);
    if (refill.advanceTicks === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, refill.waitMs));
      continue;
    }
    progress = advanceLive(simulation, refill.advanceTicks);
    postLive(request, progress.done ? 'complete' : 'progress', progress.trace, progress.recordedUntil);
    // Let cancellation, pause, and a newer document revision preempt long
    // catch-up work without imposing a fixed delay on normal playback.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** One bounded native batch plus the trace recorded so far, for incremental publication. */
function advanceLive(simulation: SimulationHandle, maxTicks: number): { done: boolean; trace: SimTrace; recordedUntil: number } {
  const { done } = simulation.advance(maxTicks);
  const trace = simulation.trace();
  return { done, trace, recordedUntil: trace.ticks.t[trace.ticks.t.length - 1] ?? 0 };
}

async function waitUntilPlaying(id: number, token: number): Promise<void> {
  while (token === liveGeneration && transport?.id === id && !transport.playing) {
    await new Promise<void>((resolve) => {
      if (!transport || transport.id !== id || transport.playing) resolve();
      else transport.wake = resolve;
    });
  }
}

function postLive(
  request: ScenarioWorkerStartRequest,
  kind: 'ready' | 'progress' | 'complete',
  trace: SimTrace,
  recordedUntil: number,
): void {
  scope.postMessage({ id: request.id, revision: request.revision, ok: true, kind, trace, recordedUntil } satisfies ScenarioWorkerResponse);
}

function postFailure(id: number, revision: string, reason: unknown): void {
  scope.postMessage({
    id,
    revision,
    ok: false,
    error: reason instanceof Error ? reason.message : String(reason),
  } satisfies ScenarioWorkerResponse);
}

function simulateForRequest(
  engine: EngineRuntime,
  input: SimScenarioInput,
  graph: LaneGraph,
  operation: ScenarioWorkerRequest['operation'],
  request: ScenarioWorkerRequest,
): SimResult {
  postPrepareProgress(request, 'simulation');
  input = withStableHighSpeedWorldRoutes(input);
  input = withBoundedSpeedCruiseRestoration(input);
  if (operation !== 'materialize') return runCanonicalPreview(engine, input, graph);
  const session = engine.simulation(input, { graph });
  // Authoring needs the warmed t=0 world, not a speculative 20-second trace.
  // The same concrete world is handed to the live run when Play is pressed.
  session.advance(Math.round(input.warmupSeconds / input.dt) + 1);
  const executed = session.input();
  preparedLiveSessions.clear();
  preparedLiveSessions.set(contentHash(executed), session);
  return { input: executed, trace: session.trace(), issues: session.issues(), arrival: session.arrival() };
}

function postPrepareProgress(
  request: ScenarioWorkerRequest,
  phase: 'map-assets' | 'map-collisions' | 'simulation',
): void {
  // Robustness runs use a short-lived one-response worker whose caller treats
  // any non-report message as terminal.
  if (request.kind === 'robustness') return;
  scope.postMessage({
    id: request.id,
    revision: request.revision ?? String(request.id),
    ok: true,
    kind: 'prepare-progress',
    phase,
  } satisfies ScenarioWorkerResponse);
}

/** Generate the requested background population natively; the population is a pure function of map graph, profile and base input. */
function applyRequestedAmbientPopulation(
  engine: EngineRuntime,
  base: SimScenarioInput,
  graph: LaneGraph,
  request: ScenarioWorkerRequest,
): AmbientTrafficResult {
  const generated = engine.materializeAmbientTraffic(base, graph, request.ambientTraffic);
  return { input: JSON.parse(generated.scenario.toJson()) as SimScenarioInput, provenance: generated.provenance };
}

function isAmbientSimActor(actor: { readonly id: string; readonly tags: readonly string[] }): boolean {
  return actor.id.startsWith('ambient:')
    || actor.id.startsWith('ambient-')
    || actor.tags.some((tag) => tag === 'ambient' || tag.startsWith('ambient:'));
}

/** Baked parked cars carry the `parked:` id prefix `withParkedCarActors` writes. */
function isParkedSimActor(actor: { readonly id: string }): boolean {
  return actor.id.startsWith('parked:');
}


function createOpenScenarioSnapshot(
  engine: EngineRuntime,
  template: ScenarioTemplateV2,
  instance: unknown,
  input: SimScenarioInput,
  trace: SimTrace,
  graph: LaneGraph,
  _xodr: string,
): OpenScenarioSnapshot {
  const manifest = (instance as { manifest: { instanceId: string } }).manifest;
  const templateHash = contentHash(template);
  const inputHash = contentHash(input);
  const traceHash = engine.traceDigest(trace);
  const filenameStem = template.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';
  const mapping = sourceMapping(input);
  try {
    const result = exportOpenScenarioXml14(input, {
      engine,
      graph,
      roadFile: `${input.mapId}.xodr`,
      executionMode: 'trajectory-replay',
      author: template.meta.author ?? 'SimForge Studio',
      description: template.meta.description || template.meta.name,
      provenance: { templateHash, inputHash, laneGraphDigest: graph.digest },
    });
    return {
      version: 1,
      source: { name: template.meta.name, templateHash, mapping },
      concrete: { input, inputHash, instanceId: manifest.instanceId, traceHash, traceHeader: trace.header, trace },
      map: { id: input.mapId, roadFile: `${input.mapId}.xodr`, xodrDigest: graph.digest, laneGraphDigest: graph.digest },
      artifact: {
        state: 'ready',
        standard: 'ASAM OpenSCENARIO XML 1.4.0',
        profile: 'xml-1.4-trajectory-replay',
        intent: 'trajectory-replay',
        filename: `${filenameStem}.xosc`,
        mediaType: 'application/xml',
        content: result.content,
        capabilityReport: result.capabilityReport,
        warnings: result.warnings,
        issues: [],
      },
      validation: validationStages(true, result.warnings.length, input.mapId, graph.digest),
    };
  } catch (reason) {
    const issues = reason instanceof AsamExportError
      ? reason.issues
      : [{ code: 'export_failed', path: 'input', reason: reason instanceof Error ? reason.message : String(reason) }];
    return {
      version: 1,
      source: { name: template.meta.name, templateHash, mapping },
      concrete: { input, inputHash, instanceId: manifest.instanceId, traceHash, traceHeader: trace.header, trace },
      map: { id: input.mapId, roadFile: `${input.mapId}.xodr`, xodrDigest: graph.digest, laneGraphDigest: graph.digest },
      artifact: {
        state: 'rejected',
        standard: 'ASAM OpenSCENARIO XML 1.4.0',
        profile: 'xml-1.4-trajectory-replay',
        intent: 'trajectory-replay',
        filename: `${filenameStem}.xosc`,
        mediaType: 'application/xml',
        content: null,
        capabilityReport: null,
        warnings: [],
        issues,
      },
      validation: validationStages(false, 0, input.mapId, graph.digest),
    };
  }
}

/** Preserve authored control programs verbatim and fill only missing physical
 * map controls. This keeps authored signal overrides stable while allowing
 * ambient traffic elsewhere in the city to obey the same real heads. */
function withMapControls(input: SimScenarioInput, controls: MapControlPlan): SimScenarioInput {
  const signalIds = new Set(input.signalPrograms.map((program) => program.id));
  const roadControlIds = new Set(input.roadControls.map((control) => control.id));
  return {
    ...input,
    signalPrograms: [
      ...input.signalPrograms,
      ...controls.signalPrograms.filter((program) => !signalIds.has(program.id)),
    ],
    roadControls: [
      ...input.roadControls,
      ...controls.roadControls.filter((control) => !roadControlIds.has(control.id)),
    ],
  };
}

function validationStages(exported: boolean, warnings: number, mapId: string, graphDigest: string): OpenScenarioSnapshot['validation'] {
  return [
    { id: 'internal-model', label: 'Concrete model', status: 'passed', detail: 'Materialized input and canonical trace passed strict Studio playback validation.' },
    { id: 'xml-profile', label: 'XML 1.4 export profile', status: exported ? 'passed' : 'failed', detail: exported ? `Fail-closed trajectory profile generated${warnings ? ` with ${warnings} warning(s)` : ''}.` : 'Unsupported or invalid semantics rejected the artifact.' },
    { id: 'official-xsd', label: 'Official ASAM XSD', status: exported ? 'pending' : 'not-run', detail: exported ? 'Awaiting pinned official schema validation.' : 'No XML artifact to validate.' },
    { id: 'dependencies', label: 'Dependencies', status: 'pending', detail: `Full ${mapId}.xodr must resolve to lane graph ${graphDigest}.` },
    { id: 'external-execution', label: 'External execution', status: 'not-run', detail: 'No pinned external runner result is attached to this immutable snapshot.' },
    { id: 'behavior-parity', label: 'Behavior parity', status: 'not-run', detail: 'Requires an external trace before quantitative comparison.' },
  ];
}

function sourceMapping(input: SimScenarioInput): OpenScenarioSourceMapping[] {
  const id = (prefix: string, raw: string): string => {
    let stem = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (!stem || /^[0-9]/.test(stem)) stem = `id_${stem || 'unnamed'}`;
    return `${prefix}_${stem}`;
  };
  return [
    ...input.actors.flatMap((actor, index) => [
      { sourcePath: `actors.${index}`, sourceId: actor.id, exportKind: 'entity' as const, exportName: id('actor', actor.id), selector: `ScenarioObject[name="${id('actor', actor.id)}"]` },
      { sourcePath: `actors.${index}.route`, sourceId: actor.id, exportKind: 'trajectory' as const, exportName: id('trajectory', actor.id), selector: `Trajectory[name="${id('trajectory', actor.id)}"]` },
    ]),
    ...input.interactions.map((interaction, index) => ({ sourcePath: `interactions.${index}`, sourceId: interaction.id, exportKind: 'event' as const, exportName: id('interaction', interaction.id), selector: `Event[name="${id('interaction', interaction.id)}"]` })),
    ...input.signalPrograms.map((program, index) => ({ sourcePath: `signalPrograms.${index}`, sourceId: program.id, exportKind: 'signal' as const, exportName: program.id, selector: `TrafficSignalController[name="${program.id}"]` })),
  ];
}

function robustnessResponse(
  engine: EngineRuntime,
  request: ScenarioWorkerRequest,
  input: SimScenarioInput,
  graph: LaneGraph,
): ScenarioWorkerResponse {
  const filters = request.evaluationFilters ?? {};
  const report = evaluateAmbientRobustness(engine, input, graph, undefined, {
    filters,
    now: () => performance.now(),
  });
  const rubric = request.intentRubric;
  const baselineIntent = rubric ? engine.trace(report.baselineTrace).evaluateIntentRubric(rubric) : null;
  const caseIntent = rubric
    ? Object.fromEntries(report.cases.map((item) => [item.label, engine.trace(item.trace).evaluateIntentRubric(rubric).verdict])) as Record<string, 'accept' | 'reject'>
    : {};
  const gate = ambientRobustnessGate(report.accepted, baselineIntent ? {
    baseline: baselineIntent.verdict,
    cases: caseIntent,
  } : null);
  return {
    id: request.id,
    revision: request.revision ?? String(request.id),
    ok: true,
    kind: 'robustness',
    report: {
      version: 1,
      baseInputHash: report.baseInputHash,
      baselineVerdict: report.baselineEvaluation.verdict,
      accepted: gate.accepted,
      overall: gate.overall,
      intent: {
        status: rubric ? 'evaluated' : 'not_evaluated',
        baselineVerdict: baselineIntent?.verdict ?? null,
        caseVerdicts: caseIntent,
      },
      filters,
      cases: report.cases.map((item) => ({
        label: item.label,
        accepted: item.accepted,
        deterministic: item.deterministic,
        authoredEventOrderPreserved: item.authoredEventOrderPreserved,
        authoredNeverFiredPreserved: item.authoredNeverFiredPreserved,
        ambientCollisions: item.ambientCollisions,
        runtimeMs: item.runtimeMs,
        generatedActors: item.provenance.actors.length,
        profileHash: item.provenance.profileHash,
        verdict: item.evaluation.verdict,
        failures: item.failures,
        warnings: item.provenance.warnings,
      })),
    },
  };
}

function ambientInstance(
  baseManifest: Record<string, any>,
  input: SimScenarioInput,
  provenance: AmbientTrafficProvenance,
  engineIssues: ReadonlyArray<SimResult['issues'][number]> = [],
): unknown {
  // The blank-world path may remove its schema-only seed actor after ambient
  // population has been materialized. Always derive identity from the exact
  // input returned to playback rather than trusting an earlier intermediate
  // hash; otherwise the editor rejects its own freshly prepared scenario.
  const generatedInputHash = contentHash(input);
  const normalizedProvenance = provenance.generatedInputHash === generatedInputHash
    ? provenance
    : { ...provenance, generatedInputHash };
  const authored = new Map((baseManifest['actors'] as Array<Record<string, unknown>>).map((actor) => [actor['id'], actor]));
  const actors = input.actors.map((actor) => authored.get(actor.id) ?? {
    id: actor.id,
    actorKind: actor.kind,
    roleKind: 'ambient',
    origin: 'ambient',
    timelineVisible: false,
    editable: false,
    laneRsl: actor.initial.laneRef?.rsl ?? null,
    spawnS: actor.initial.laneRef?.s ?? 0,
    initialSpeedMps: actor.initial.speedMps,
    bindingStatus: 'generated',
  });
  const issues = [...(Array.isArray(baseManifest['issues']) ? baseManifest['issues'] : []), ...engineIssues]
    .filter((entry, index, all) => all.findIndex((candidate) =>
      candidate?.code === entry?.code && candidate?.path === entry?.path && candidate?.reason === entry?.reason) === index);
  return {
    kind: 'scenario-instance',
    version: 1,
    manifest: {
      ...baseManifest,
      inputHash: generatedInputHash,
      instanceId: `${String(baseManifest['instanceId'])}@ambient:${provenance.profileHash.slice(0, 12)}`,
      actors,
      issues,
      ambientTraffic: normalizedProvenance,
      ambientBaseInputHash: provenance.baseInputHash,
    },
    input,
    ambientTraffic: normalizedProvenance,
  };
}

async function fetchBytes(url: string, sha256?: string): Promise<Uint8Array> {
  const response = await fetch(await resolveAssetUrl(url, sha256));
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decode gzip map artifacts');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchJson(url: string, sha256?: string): Promise<any> {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(url, sha256)));
}

async function fetchText(url: string, sha256?: string): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(url, sha256));
}
