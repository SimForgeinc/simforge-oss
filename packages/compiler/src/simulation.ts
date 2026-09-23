/**
 * Authoritative, content-addressed simulation.
 *
 * `trace = simulate(resolvedInput, mapClosure, engineSemantics)` is a pure
 * function, so its result is memoized under a key built from exactly those
 * inputs and computed once by the host (inline in the API, or on a CPU
 * runner). Every consumer replays that trace; nobody re-simulates.
 *
 * The map closure is built with the editor's own map loader
 * (`@simforge-oss/playback` `loadMapGraph`) over the same browser asset members
 * the editor loads, including the static map colliders. A worker trace
 * computed here and the editor's local WASM trace are therefore the same
 * function of the same bytes, and their `traceSha256` values are compared to
 * label the editor's preview "Verified".
 *
 * Identities (see docs/engineering/simulation-results.md):
 * - `resolvedInputDigest` = {@link executionSourceInputDigest} of the input the engine resolves.
 * - `mapClosureDigest` = H(browser closure digest, static collider digest).
 * - `traceSha256` = the engine's native trace digest, never the gzip bytes.
 * - `simKey` = H(resolvedInputDigest, mapClosureDigest, engineSemVer, solverVer, traceSchema).
 *   Build digests are provenance only: a rebuild must not miss the cache.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  ambientTrafficProfileForDocument,
  canonicalJson,
  contentHash,
  createDisabledMaterializedTrafficArtifact,
  MaterializedTrafficRecorder,
  createSumoTrafficStep,
  TRACE_FORMAT_VERSION,
  type SumoRuntime,
  type SumoTrafficNetwork,
  type MaterializedTrafficArtifactEnvelope,
  type MaterializedTrafficFrameActor,
  type ResolvedAmbientTrafficProfile,
  type SimTrace,
} from '@simforge-oss/engine';
import {
  engine,
  loadSumoRuntime,
  PINNED_SUMO_RUNTIME_VERSION,
  PINNED_SUMO_WASM_SHA256,
  runtimeIdentity,
  stageSumoRuntime,
  sumoTrafficNetworkFromMembers,
  type SumoRuntimeFile,
} from '@simforge-oss/engine/node';
import {
  buildSimulationMapClosure,
  loadMapGraph,
  type MapClosureFiles,
  type MapGraph,
  type MapGraphDigests,
  type MapGraphSources,
} from '@simforge-oss/playback';
import {
  ambientTrafficProviderFromExtensions,
  previewExecutionTrafficProvider,
  type AmbientTrafficProviderId,
} from '@simforge-oss/playback/traffic';
import { upgradeScenarioDocument } from '@simforge-oss/scenario';

import {
  executionSourceInputDigest,
  resolveExecutionInput,
  type AmbientExecutionMode,
  type ResolvedExecutionInput,
} from './execution-package.js';
import { persistAmbientTurnVerdictsToDisk, restoreAmbientTurnVerdictsFromDisk } from './maps.js';
import type { MaterializeOptions } from './materialize.js';
import { MapBundle } from './types.js';

export const SIM_KEY_CONTRACT = 'simforge.sim-key/v1';
export const MAP_CLOSURE_CONTRACT = 'simforge.map-closure/v1';
/** The canonical trace schema a `traceSha256` identifies. */
export const TRACE_SCHEMA = `simforge.trace/v${TRACE_FORMAT_VERSION}`;
/** Stored media type of an authoritative trace object (`sim/sha256/<traceSha>.trace.json.gz`). */
export const SIMULATION_TRACE_MEDIA_TYPE = 'application/vnd.simforge.trace+json+gzip';

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Engine semantics identity: `ENGINE_SEM_VER`, the manually bumped semantics
 * version enforced by the golden-trace corpus. `solverVer` is kept as a
 * separate key field but equals `engineSemVer` until the solver versions
 * independently.
 */
export function engineSemantics(): { readonly engineSemVer: string; readonly solverVer: string } {
  const { engineSemVer } = engine().version();
  return { engineSemVer, solverVer: engineSemVer };
}

/** Build provenance recorded next to a result; never part of its key. */
export function engineBuildProvenance(): Readonly<Record<string, unknown>> {
  try {
    const identity = runtimeIdentity();
    return { engineVersion: identity.engineVersion, abiVersion: identity.abiVersion, addonSha256: identity.addonSha256 };
  } catch {
    const version = engine().version();
    return { engineVersion: version.engineVersion, abiVersion: version.abiVersion };
  }
}

export interface MapClosureIdentity {
  /** Identity of the published browser member closure the editor loads. */
  readonly browserClosureSha256: string;
  /** Digest of the verified static collider artifact built into the graph. */
  readonly colliderDigest: string;
}

/**
 * Provenance digest of the published members a closure was loaded from. The
 * key uses the loaded bundle's own `closureDigest` (`simforge.map-closure/v1`
 * over the consumed content: topology with speed limits, filtered colliders,
 * collider status, signal catalog), which N-API and WASM compute identically.
 */
export function mapClosureIdentityDigest(identity: MapClosureIdentity): string {
  return contentHash({
    contract: MAP_CLOSURE_CONTRACT,
    browserClosureSha256: identity.browserClosureSha256,
    colliderDigest: identity.colliderDigest,
  });
}

export interface SimKeyInput {
  readonly resolvedInputDigest: string;
  readonly mapClosureDigest: string;
  readonly engineSemVer: string;
  readonly solverVer: string;
  readonly traceSchema: string;
  /**
   * Key of an external traffic step merged into the trace (server-side SUMO,
   * WS-E). Absent for native/off traffic, so those keys never change shape.
   */
  readonly trafficStepKey?: string | null;
}

/** The content address of one authoritative simulation. */
export function simKey(input: SimKeyInput): string {
  return contentHash({
    v: SIM_KEY_CONTRACT,
    resolvedInputDigest: input.resolvedInputDigest,
    mapClosureDigest: input.mapClosureDigest,
    engineSemVer: input.engineSemVer,
    solverVer: input.solverVer,
    traceSchema: input.traceSchema,
    ...(input.trafficStepKey ? { trafficStepKey: input.trafficStepKey } : {}),
  });
}

/**
 * One-way external traffic (SUMO on workers, WS-E): given the authored trace
 * simulated with ambient traffic off, produce the merged trace. Authored
 * tracks are unchanged by contract; `stepKey` covers every SUMO input.
 */
export type ExternalTrafficStep = (input: {
  readonly authoredTrace: SimTrace;
  readonly resolvedInput: ResolvedExecutionInput['resolvedInput'];
  readonly sourceInputDigest: string;
  readonly closure: SimulationMapClosure;
}) => {
  readonly trace: SimTrace;
  readonly stepKey: string;
  readonly envelope: MaterializedTrafficArtifactEnvelope;
  readonly ambient: SimulationAmbientProvenanceSumo;
};

/** A map closure ready to simulate against: the graph carries the static colliders. */
export interface SimulationMapClosure {
  readonly mapVersionId: string;
  readonly mapAssetId: string;
  readonly bundle: MapBundle;
  readonly xodr: string;
  /** The exact `topology-index.json(.gz)` bytes the graph was built from (the timeline's height source input). */
  readonly topology: Uint8Array;
  /** `derived/ground/ground-mesh.bin` when the version carries it: the engine grounds bodies on it and the timeline bakes from it. */
  readonly ground: Uint8Array | null;
  readonly identity: MapClosureIdentity;
  readonly mapClosureDigest: string;
}

/**
 * Load a simulation map closure through the editor's own loader. `sources`
 * are the same member URLs the editor worker receives (`playbackMapEntry`),
 * resolved by `fetcher` (a server resolves them to the verified member bytes).
 * Fails closed without a verified static collider artifact, exactly as the
 * editor does.
 */
export async function loadSimulationMapClosure(options: {
  readonly mapVersionId: string;
  readonly mapAssetId: string;
  readonly browserClosureSha256: string;
  readonly sources: Omit<MapGraphSources, 'mapId'>;
  readonly digests?: MapGraphDigests;
  readonly fetcher: typeof fetch;
}): Promise<SimulationMapClosure> {
  // Keep the topology member's exact bytes: the render timeline derives its
  // height field from them, so every executor must hand it the same bytes.
  let topology: Uint8Array | null = null;
  const topologyUrl = new URL(options.sources.topology, 'http://closure.invalid/').href;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await options.fetcher(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://closure.invalid/').href;
    if (url !== topologyUrl || !response.ok) return response;
    topology = new Uint8Array(await response.arrayBuffer());
    return new Response(topology.slice(), { status: response.status, headers: response.headers });
  }) as typeof fetch;
  const graph = await loadMapGraph({
    module: engine().module,
    sources: { ...options.sources, mapId: options.mapAssetId },
    ...(options.digests ? { digests: options.digests } : {}),
    fetcher,
  });
  if (!topology) throw new Error('simulation_closure_topology_missing');
  const closure = closureFromGraph(graph, options, plainBytes(topology));
  await restoreAmbientTurnVerdictsFromDisk(closure.bundle);
  return closure;
}

/** Members are served gzipped or plain; the closure keeps the plain JSON bytes whichever way they arrived. */
function plainBytes(bytes: Uint8Array): Uint8Array {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(gunzipSync(bytes)) : bytes;
}

/**
 * A simulation map closure from the map's files (an installed map directory,
 * `readInstalledMapClosureFiles`, or fixtures), built through the same
 * constructor the editor's loader uses. Colliders verify or it fails closed.
 */
export async function simulationMapClosureFromFiles(
  files: MapClosureFiles,
  identity: { readonly mapVersionId: string; readonly mapAssetId: string; readonly browserClosureSha256: string },
): Promise<SimulationMapClosure> {
  const graph = await buildSimulationMapClosure(engine().module, files);
  const closure = closureFromGraph(graph, identity, plainBytes(files.topology));
  await restoreAmbientTurnVerdictsFromDisk(closure.bundle);
  return closure;
}

function closureFromGraph(
  graph: MapGraph,
  options: { readonly mapVersionId: string; readonly mapAssetId: string; readonly browserClosureSha256: string },
  topology: Uint8Array,
): SimulationMapClosure {
  const bundle = new MapBundle(graph.bundle, { derived: graph.derived as never, catalog: graph.locations as never });
  const identity = { browserClosureSha256: options.browserClosureSha256, colliderDigest: graph.collision.diagnostics.digest };
  if (!graph.closureDigest) throw new Error('simulation_closure_digest_missing');
  return {
    mapVersionId: options.mapVersionId,
    mapAssetId: options.mapAssetId,
    bundle,
    xodr: graph.xodr,
    topology,
    ground: graph.ground,
    identity,
    mapClosureDigest: graph.closureDigest,
  };
}

/**
 * The ambient provider a document executes with. A SUMO document simulates
 * its authored actors with ambient traffic off; its traffic is the external
 * SUMO step (`prepareSumoTrafficStep`), one-way against the authored trace
 * and merged into it.
 */
export function executionTrafficProvider(content: {
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly mapSignalPlans?: readonly unknown[];
}): AmbientTrafficProviderId {
  return previewExecutionTrafficProvider(
    ambientTrafficProviderFromExtensions(content.extensions),
    (content.mapSignalPlans?.length ?? 0) > 0,
  );
}

/**
 * Stored content keeps the `scenarioVersion` it was written with. The
 * authoritative simulation reads the upgraded (current-version) document, so
 * an absent field means what the current code says it means. (Request
 * identity, `sumoStepIdentity`, keys on the stored content as it is.)
 */
function currentDocument(content: unknown): Record<string, unknown> {
  return upgradeScenarioDocument(content).document;
}

function ambientModeFor(provider: AmbientTrafficProviderId): AmbientExecutionMode {
  return provider === 'native' ? 'native' : provider === 'sumo' ? 'sumo' : 'disabled';
}

export interface SimulationAmbientProvenanceSumo {
  readonly mode: 'sumo';
  readonly sumoVersion: string;
  readonly networkSha256: string;
  readonly seed: string | number;
  readonly ambientConfig: Readonly<Record<string, unknown>>;
  readonly configSha256: string;
  readonly resultSha256: string;
}

/**
 * The external traffic step for a SUMO document (WS-E): the pinned SUMO
 * runtime runs at the fixed step against the authored trace (one-way coupling,
 * obeying the SimForge signal book) and its vehicles are merged into the
 * trace as ordinary actors. Prepare one per simulation; a prepared module runs
 * once.
 */
export async function prepareSumoTrafficStep(
  content: { readonly simulation?: unknown; readonly extensions?: Readonly<Record<string, unknown>> },
  runtime: SumoRuntime,
  network: SumoTrafficNetwork,
): Promise<ExternalTrafficStep> {
  const step = await createSumoTrafficStep(runtime, {
    profile: ambientTrafficProfileForDocument(content),
    network,
    traceDigest: (trace) => engine().traceDigest(trace),
  });
  return (input) => step({
    authoredTrace: input.authoredTrace,
    resolvedInput: input.resolvedInput,
    sourceInputDigest: input.sourceInputDigest,
    closure: { mapAssetId: input.closure.mapAssetId, mapVersionId: input.closure.mapVersionId },
  });
}

/** The map version member that names and pins the SUMO network. */
export const SUMO_NETWORK_MANIFEST_MEMBER = 'derived/sumo/sumo-network-manifest.json';
export const SUMO_RUNTIME_FILES: readonly SumoRuntimeFile[] = ['sumo.mjs', 'sumo.wasm', 'runtime-manifest.json'];
/** Where the pinned runtime lives in the runtime bucket. */
export const SUMO_RUNTIME_OBJECT_PREFIX = `uniscenario/sumo-runtime/${PINNED_SUMO_RUNTIME_VERSION}/`;

/**
 * What the SUMO step of a request depends on beyond the document and the
 * closure: the map version's network digest and the pinned runtime build.
 * `null` for documents that do not run SUMO. Hosts fold it into the request
 * key so a request never resolves to a result computed without the step.
 */
export function sumoStepIdentity(
  content: unknown,
  sumoNetworkSha256: string | null,
): { readonly sumoNetworkSha256: string | null; readonly wasmSha256: string } | null {
  if (executionTrafficProvider(content as { extensions?: Record<string, unknown> }) !== 'sumo') return null;
  return { sumoNetworkSha256, wasmSha256: PINNED_SUMO_WASM_SHA256 };
}

/**
 * The pinned SUMO runtime, staged once per directory and process from
 * wherever the host keeps it (object store, presigned URLs, a volume). The
 * compiled module is shared; every step instantiates a fresh one.
 */
const stagedRuntimes = new Map<string, Promise<SumoRuntime>>();
export function stagedSumoRuntime(
  directory: string,
  read: (file: SumoRuntimeFile) => Promise<Uint8Array>,
): Promise<SumoRuntime> {
  const cached = stagedRuntimes.get(directory);
  if (cached) return cached;
  const staging = stageSumoRuntime({ directory, read }).then(() => loadSumoRuntime(directory));
  stagedRuntimes.set(directory, staging);
  staging.catch(() => { if (stagedRuntimes.get(directory) === staging) stagedRuntimes.delete(directory); });
  return staging;
}

/**
 * The external traffic step a host runs for `content`, or `undefined` when
 * the document does not run SUMO. A SUMO document on a map version without a
 * SUMO network is a scenario error (`sumo_network_unavailable`): simulating it
 * without its traffic would store a result that is not what the author asked
 * for.
 */
export async function hostTrafficStep(
  content: unknown,
  sources: {
    readonly sumoNetworkSha256: string | null;
    /** A verified map version member by relative path (`derived/sumo/...`). */
    readonly readMember: (relativePath: string) => Promise<Uint8Array>;
    readonly runtime: () => Promise<SumoRuntime>;
  },
): Promise<ExternalTrafficStep | undefined> {
  const document = content as { simulation?: unknown; extensions?: Record<string, unknown> };
  if (executionTrafficProvider(document) !== 'sumo') return undefined;
  if (!sources.sumoNetworkSha256) {
    throw new Error('sumo_network_unavailable: the map version publishes no SUMO network; republish the map with its SUMO derivative');
  }
  const manifestBytes = await sources.readMember(SUMO_NETWORK_MANIFEST_MEMBER);
  const { networkFile } = JSON.parse(new TextDecoder().decode(manifestBytes)) as { networkFile?: unknown };
  if (typeof networkFile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(networkFile)) {
    throw new Error('sumo_network_unavailable: the SUMO network manifest names no network file');
  }
  const network = sumoTrafficNetworkFromMembers({
    manifest: manifestBytes,
    network: await sources.readMember(`derived/sumo/${networkFile}`),
    expectedSha256: sources.sumoNetworkSha256,
  });
  return prepareSumoTrafficStep(document, await sources.runtime(), network);
}

/** The ambient provenance a revision records for its materialized traffic. */
export type SimulationAmbientProvenance =
  | SimulationAmbientProvenanceSumo
  | { readonly mode: 'disabled'; readonly ambientConfig: Record<string, never>; readonly configSha256: string; readonly resultSha256: string }
  | {
      readonly mode: 'native';
      readonly runtimeVersion: string;
      readonly seed: string | number;
      readonly ambientConfig: ResolvedAmbientTrafficProfile;
      readonly configSha256: string;
      readonly resultSha256: string;
    };

export interface AuthoritativeSimulation {
  readonly simKey: string;
  readonly traceSha256: string;
  /**
   * Digest of the trace of the authored actors alone. Equal to `traceSha256`
   * unless an external traffic step merged actors in; the editor's local
   * preview (ambient off for SUMO documents) is verified against this.
   */
  readonly authoredTraceSha256: string;
  readonly trafficStepKey: string | null;
  readonly resolvedInputDigest: string;
  readonly mapClosureDigest: string;
  readonly engineSemVer: string;
  readonly solverVer: string;
  readonly traceSchema: string;
  readonly engineBuild: Readonly<Record<string, unknown>>;
  readonly provider: AmbientTrafficProviderId;
  readonly resolved: ResolvedExecutionInput;
  readonly trace: SimTrace;
  /** Deterministic gzip of the engine's trace JSON: the stored object. */
  readonly traceGzip: Uint8Array;
  readonly traceGzipSha256: string;
  /**
   * Materialized ambient traffic derived from the authoritative trace, for the
   * revision's execution binding. `null` for a SUMO document when no external
   * traffic step is available on this host (the trace is then authored-only).
   */
  readonly traffic: {
    readonly envelope: MaterializedTrafficArtifactEnvelope;
    readonly ambient: SimulationAmbientProvenance;
  } | null;
  readonly simulateMs: number;
}

/** Deterministic gzip: fixed level, no filename, mtime 0 (Node's default header). */
export function gzipTrace(trace: SimTrace): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(trace)), { level: 9 }));
}

/**
 * Simulate one map-bound document authoritatively. Runs the refined input the
 * editor runs, over the collider-bearing closure, on this process's native
 * engine; returns the trace, its identities and the traffic evidence.
 */
export function simulateAuthoritative(request: {
  readonly canonicalContent: unknown;
  readonly closure: SimulationMapClosure;
  readonly catalogEntries?: MaterializeOptions['catalogEntries'];
  /** Host-provided SUMO step for `provider === 'sumo'` documents. */
  readonly trafficStep?: ExternalTrafficStep;
}): AuthoritativeSimulation {
  const started = performance.now();
  const content = currentDocument(request.canonicalContent) as { extensions?: Record<string, unknown>; mapSignalPlans?: unknown[]; simulation?: unknown };
  const provider = executionTrafficProvider(content);
  const resolved = resolveExecutionInput(
    content,
    request.closure.bundle,
    ambientModeFor(provider),
    request.catalogEntries,
  );
  const result = engine().runSimulation(resolved.executedInput, { graph: request.closure.bundle.graph });
  // Timing only (WS-A): the turn verdicts the ambient generator probed are
  // persisted per closure and engine semantics; errors are swallowed.
  if (provider === 'native') void persistAmbientTurnVerdictsToDisk(request.closure.bundle);
  const authoredTrace = result.trace;
  const resolvedInputDigest = executionSourceInputDigest(resolved.resolvedInput);
  // The stored resolution record must be exactly the input this trace was
  // simulated from: the export binds the trace to it, and replayers rebuild
  // the playback instance from it.
  if (authoredTrace.header.inputHash !== resolvedInputDigest) {
    throw new Error(`simulation_input_identity_mismatch: trace ${authoredTrace.header.inputHash}, resolved ${resolvedInputDigest}`);
  }
  const authoredTraceSha256 = engine().traceDigest(authoredTrace);
  const step = provider === 'sumo' && request.trafficStep
    ? request.trafficStep({ authoredTrace, resolvedInput: resolved.resolvedInput, sourceInputDigest: resolvedInputDigest, closure: request.closure })
    : null;
  const trace = step?.trace ?? authoredTrace;
  const traceSha256 = step ? engine().traceDigest(trace) : authoredTraceSha256;
  const { engineSemVer, solverVer } = engineSemantics();
  const key = simKey({
    resolvedInputDigest,
    mapClosureDigest: request.closure.mapClosureDigest,
    engineSemVer,
    solverVer,
    traceSchema: TRACE_SCHEMA,
    trafficStepKey: step?.stepKey ?? null,
  });
  const traceGzip = gzipTrace(trace);
  const traffic = step
    ? { envelope: step.envelope, ambient: step.ambient }
    : provider === 'sumo'
    ? null
    : materializeTraceTraffic({
        provider,
        // The same resolution the compiler's concrete input applies (a pinned
        // document without a profile runs with ambient traffic off).
        profile: ambientTrafficProfileForDocument(content),
        sourceInputDigest: resolvedInputDigest,
        map: { assetId: request.closure.mapAssetId, versionId: request.closure.mapVersionId },
        trace,
        ambientActorIds: resolved.concrete.ambientTraffic.actors.map((actor) => actor.id),
      });
  return {
    simKey: key,
    traceSha256,
    authoredTraceSha256,
    trafficStepKey: step?.stepKey ?? null,
    resolvedInputDigest,
    mapClosureDigest: request.closure.mapClosureDigest,
    engineSemVer,
    solverVer,
    traceSchema: TRACE_SCHEMA,
    engineBuild: engineBuildProvenance(),
    provider,
    resolved,
    trace,
    traceGzip,
    traceGzipSha256: sha256Hex(traceGzip),
    traffic,
    simulateMs: performance.now() - started,
  };
}

/**
 * Materialized ambient traffic from a raw (xodr-local) trace. The same frame
 * content the editor used to upload as evidence, now derived by the authority
 * from its own trace: scene z = -y, every tick on the fixed grid.
 */
export function materializeTraceTraffic(input: {
  readonly provider: Exclude<AmbientTrafficProviderId, 'sumo'>;
  readonly profile: ResolvedAmbientTrafficProfile;
  readonly sourceInputDigest: string;
  readonly map: { readonly assetId: string; readonly versionId: string };
  readonly trace: SimTrace;
  readonly ambientActorIds: readonly string[];
}): { envelope: MaterializedTrafficArtifactEnvelope; ambient: SimulationAmbientProvenance } {
  const { trace } = input;
  const times = trace.ticks.t;
  const durationSeconds = times.length > 0 ? times[times.length - 1]! - times[0]! : 0;
  if (input.provider === 'off') {
    const envelope = createDisabledMaterializedTrafficArtifact({
      sourceInputDigest: input.sourceInputDigest,
      map: input.map,
      fixedStepSeconds: trace.header.dt,
      durationSeconds,
    });
    return {
      envelope,
      ambient: { mode: 'disabled', ambientConfig: {}, configSha256: contentHash({}), resultSha256: envelope.sha256 },
    };
  }
  const recorder = new MaterializedTrafficRecorder({
    sourceInputDigest: input.sourceInputDigest,
    map: input.map,
    provider: { id: 'native', version: trace.header.engineVersion, seed: String(input.profile.seed) },
    fixedStepSeconds: trace.header.dt,
    durationSeconds,
  });
  const kinds = new Map(Object.entries(trace.header.actorMetadata ?? {}).map(([id, meta]) => [id, (meta as { kind?: string }).kind ?? 'vehicle']));
  const ambientIds = [...new Set(input.ambientActorIds)].sort();
  for (let index = 0; index < times.length; index += 1) {
    const actors: MaterializedTrafficFrameActor[] = [];
    for (const actorId of ambientIds) {
      const track = trace.ticks.actors[actorId];
      if (!track || track.present[index] !== 1) continue;
      actors.push({
        id: actorId,
        kind: materializedActorKind(kinds.get(actorId) ?? 'vehicle'),
        x: track.x[index]!,
        z: -track.y[index]!,
        headingRad: track.headingRad[index]!,
        speedMps: track.speedMps[index]!,
        accelerationMps2: 0,
        signals: 0,
      });
    }
    const signals = Object.fromEntries(
      Object.entries(trace.ticks.signals ?? {}).map(([signalId, track]) => [signalId, materializedSignalState(track.phase[index] ?? 'off')]),
    );
    recorder.record({ t: recorder.nextTime, actors, signals });
  }
  const envelope = recorder.finalize();
  return {
    envelope,
    ambient: {
      mode: 'native',
      runtimeVersion: trace.header.engineVersion,
      seed: input.profile.seed,
      ambientConfig: input.profile,
      configSha256: contentHash(input.profile),
      resultSha256: envelope.sha256,
    },
  };
}

function materializedActorKind(kind: string): MaterializedTrafficFrameActor['kind'] {
  if (kind === 'pedestrian') return 'pedestrian';
  if (kind === 'bicycle' || kind === 'scooter') return 'bicycle';
  if (['vehicle', 'car', 'truck', 'bus', 'van', 'motorcycle'].includes(kind)) return 'vehicle';
  return 'obstacle';
}

function materializedSignalState(state: string): 'green' | 'yellow' | 'red' | 'off' {
  if (state === 'green' || state === 'proceed' || state === 'green_arrow') return 'green';
  if (state === 'yellow' || state === 'flashing_yellow' || state === 'yellow_arrow') return 'yellow';
  if (state === 'red' || state === 'stop' || state === 'flashing_red' || state === 'red_x') return 'red';
  return 'off';
}

/** Canonical JSON bytes, re-exported for hosts that persist simulation metadata. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export const SIMULATION_RESOLUTION_CONTRACT = 'simforge.sim-resolution/v1';
export const SIMULATION_RESOLUTION_MEDIA_TYPE = 'application/vnd.simforge.sim-resolution+json+gzip';

/**
 * The resolution record stored beside a trace: the exact input it was
 * simulated from, with the materialization manifest and ambient provenance.
 * Exports and replayers consume it instead of resolving the document again,
 * so nothing downstream re-materializes traffic. Canonical JSON, gzip level 9.
 */
export function encodeSimulationResolution(simulation: AuthoritativeSimulation): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(canonicalJsonBytes({
    contract: SIMULATION_RESOLUTION_CONTRACT,
    simKey: simulation.simKey,
    resolvedInputDigest: simulation.resolvedInputDigest,
    resolvedInput: simulation.resolved.resolvedInput,
    ambientActorIds: simulation.resolved.concrete.ambientTraffic.actors.map((actor) => actor.id).sort(),
    ambientTraffic: simulation.resolved.concrete.ambientTraffic,
    siteId: simulation.resolved.concrete.siteId,
    materialization: simulation.resolved.concrete.materialization,
    axisUntilClamps: simulation.resolved.axisUntilClamps,
    trafficProvider: simulation.provider,
  })), { level: 9 }));
}

/** What an executor reports when it completes a simulation request (the host verifies and records it). */
export interface SimulationCompletionRecord {
  readonly simKey: string;
  readonly traceSha256: string;
  readonly authoredTraceSha256: string;
  readonly engineSemVer: string;
  readonly solverVer: string;
  readonly traceSchema: string;
  readonly resolvedInputDigest: string;
  readonly mapClosureDigest: string;
  readonly trafficStepKey: string | null;
  readonly trafficProvider: AmbientTrafficProviderId;
  readonly engineBuild: Record<string, unknown>;
  readonly trace: { readonly sha256: string; readonly sizeBytes: number };
  readonly resolution: { readonly sha256: string; readonly sizeBytes: number };
  readonly traffic: {
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly sourceInputDigest: string;
    readonly ambient: Record<string, unknown>;
  } | null;
  /**
   * The render timeline derived from the trace (WS-B contract). The stored
   * object is its canonical JSON, uncompressed, so `sha256` is `timelineSha256`.
   */
  readonly timeline: {
    readonly timelineKey: string;
    readonly timelineSha256: string;
    readonly sizeBytes: number;
  } | null;
  readonly metrics: Record<string, number>;
}

/** The timeline step's output as `@simforge-oss/render/timeline` `buildRenderTimeline` returns it. */
export interface SimulationTimeline {
  readonly timelineKey: string;
  readonly timelineSha256: string;
  readonly traceSha256: string;
  readonly bytes: Uint8Array;
}

/** The completion record of a simulation this process executed, plus the bytes to store. */
export function simulationCompletion(simulation: AuthoritativeSimulation, timeline: SimulationTimeline | null = null): {
  readonly completion: SimulationCompletionRecord;
  readonly bytes: {
    readonly trace: Uint8Array;
    readonly resolution: Uint8Array;
    readonly traffic: Uint8Array | null;
    readonly timeline: Uint8Array | null;
  };
} {
  if (timeline && (timeline.traceSha256 !== simulation.traceSha256 || sha256Hex(timeline.bytes) !== timeline.timelineSha256)) {
    throw new Error(`simulation_timeline_mismatch: timeline of trace ${timeline.traceSha256}, simulated ${simulation.traceSha256}`);
  }
  const resolution = encodeSimulationResolution(simulation);
  return {
    completion: {
      simKey: simulation.simKey,
      traceSha256: simulation.traceSha256,
      authoredTraceSha256: simulation.authoredTraceSha256,
      engineSemVer: simulation.engineSemVer,
      solverVer: simulation.solverVer,
      traceSchema: simulation.traceSchema,
      resolvedInputDigest: simulation.resolvedInputDigest,
      mapClosureDigest: simulation.mapClosureDigest,
      trafficStepKey: simulation.trafficStepKey,
      trafficProvider: simulation.provider,
      engineBuild: { ...simulation.engineBuild },
      trace: { sha256: simulation.traceGzipSha256, sizeBytes: simulation.traceGzip.byteLength },
      resolution: { sha256: sha256Hex(resolution), sizeBytes: resolution.byteLength },
      traffic: simulation.traffic
        ? {
            sha256: simulation.traffic.envelope.sha256,
            sizeBytes: simulation.traffic.envelope.sizeBytes,
            sourceInputDigest: simulation.resolvedInputDigest,
            ambient: { ...simulation.traffic.ambient },
          }
        : null,
      timeline: timeline
        ? { timelineKey: timeline.timelineKey, timelineSha256: timeline.timelineSha256, sizeBytes: timeline.bytes.byteLength }
        : null,
      metrics: { simulateMs: Math.round(simulation.simulateMs), traceGzipBytes: simulation.traceGzip.byteLength },
    },
    bytes: {
      trace: simulation.traceGzip,
      resolution,
      traffic: simulation.traffic?.envelope.bytes ?? null,
      timeline: timeline?.bytes ?? null,
    },
  };
}
