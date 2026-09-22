/**
 * Worker SUMO traffic step: authored trace in, deterministic materialized
 * SUMO traffic out.
 *
 * Coupling is one-way (docs/engineering/sumo-worker-traffic.md). The authored
 * actors are simulated first, by the engine, with ambient traffic off. Their
 * trace is fixed input here. SUMO reacts to them through occupancy proxies,
 * and nothing SUMO does ever feeds back into an authored track.
 *
 * Fixed step and order. SUMO runs at the trace grid, `dt` = 0.02 s. SUMO
 * keeps time in integer milliseconds, so every step is exact. Before the
 * clip, SUMO pre-rolls for {@link SUMO_TRAFFIC_PRE_ROLL_SECONDS} with the
 * authored actors held still at their t = 0 poses (speed 0), so the network
 * is populated at the first frame. Frame 0 is the state after the pre-roll.
 * Frame k (k ≥ 1) is produced by exactly this order:
 *
 *   1. upsert every authored proxy at its trace pose at t_k, sorted by id, and
 *      remove proxies whose actor left the road or the world;
 *   2. advance SUMO one step. Ambient vehicles plan against the proxies'
 *      previous positions, so they react with one step (20 ms) of latency, and
 *      remote-controlled proxies land at t_k;
 *   3. read every SUMO-driven vehicle, map it to the scene frame, quantize it,
 *      and record it as frame k.
 *
 * Traffic lights are rewritten from the resolved input's signal programs
 * (see `sumo-signals.ts`). The SimForge signal book is the only signal
 * authority, and SUMO signal states are never written into the trace.
 *
 * Float32. The bridge packs positions as float32 network coordinates.
 * netconvert normalizes the network offset, so coordinates start at the
 * origin. Runs are refused when the network extent could cost more than
 * {@link SUMO_TRAFFIC_MAX_FLOAT32_ULP_M} of precision. The scene transform
 * runs in float64. Positions are then quantized to 0.1 mm and angles to
 * 1 µrad. The trace therefore never carries float32 noise, and the grid is
 * coarser than any ulp that remains.
 */

import { canonicalJson, sha256, sha256Bytes } from '../core/hash.js';
import type { RoadControl, SignalProgram } from '../schema/input.js';
import type { SimTrace } from '../trace/trace.js';
import { traceToSceneFrame } from '../trace/trace.js';
import {
  buildSumoRoadOccupancyIndex,
  sumoAuthoredOccupanciesAt,
} from './authored-occupancy.js';
import {
  MaterializedTrafficRecorder,
  materializedTrafficFrameCount,
  type MaterializedTrafficArtifactEnvelope,
  type MaterializedTrafficFrameActor,
} from './materialized-traffic.js';
import type { ResolvedAmbientTrafficProfile } from './profile.js';
import {
  sumoNetworkHeadingToScene,
  sumoNetworkToScene,
  sumoNumericSeed,
  sumoSceneHeadingToNetwork,
  sumoSceneToNetwork,
  validateSumoNetworkManifest,
  type SumoNetworkManifest,
  type SumoNetworkWorldTransform,
} from './sumo.js';
import { planSumoDemand, sumoEdgesForRoadLanes, sumoIsolatedProxyEdge, SUMO_DEMAND_ROUTE_OPTIONS, SUMO_DEMAND_WARMUP_SECONDS } from './sumo-demand.js';
import {
  SumoWasmSession,
  sumoIdHash,
  type SumoExternalProxy,
  type SumoRuntime,
  type SumoWasmModule,
} from './sumo-runtime.js';
import {
  parseSumoSignalNetwork,
  signalProgramIndicationAt,
  synthesizeSumoSignalPrograms,
  sumoLinkStateForIndication,
  type SumoSignalSynthesisReport,
} from './sumo-signals.js';

/** Bumped whenever the coupling, demand, signal rewrite or quantization changes output bytes. */
export const SUMO_TRAFFIC_COUPLING_VERSION = 'simforge.sumo-traffic/v1';
export const SUMO_TRAFFIC_STEP_SECONDS = 0.02;
export const SUMO_TRAFFIC_PRE_ROLL_SECONDS = SUMO_DEMAND_WARMUP_SECONDS;
/** Largest float32 spacing tolerated for network coordinates (network extent < 4096 m). */
export const SUMO_TRAFFIC_MAX_FLOAT32_ULP_M = 2.5e-4;
export const SUMO_TRAFFIC_POSITION_QUANTUM_M = 1e-4;
export const SUMO_TRAFFIC_ANGLE_QUANTUM_RAD = 1e-6;
export const SUMO_TRAFFIC_SPEED_QUANTUM = 1e-4;
/** Track jumps beyond speed·dt + this margin are SUMO teleports (split into a new actor). */
export const SUMO_TRAFFIC_TELEPORT_MARGIN_M = 8;
/** Explicit origin every SUMO actor carries in the merged authoritative trace. */
export const SUMO_TRAFFIC_ORIGIN = 'sumo';

/** The rendered body of every SUMO vehicle, shared by SUMO car following and the renderers. */
export const SUMO_TRAFFIC_VEHICLE = Object.freeze({
  kind: 'car' as const,
  catalogId: 'vehicle.sedan',
  dims: Object.freeze({ l: 4.55, w: 1.82, h: 1.48 }),
});

export interface SumoTrafficNetwork {
  /** Exact bytes of the map's `derived/sumo/map.net.xml`. */
  readonly bytes: Uint8Array;
  readonly manifest: SumoNetworkManifest;
}

export interface SumoTrafficInput {
  /** Authoritative authored trace, simulated with ambient traffic off. */
  readonly authoredTrace: SimTrace;
  /** Its identity as the simulate job records it (WS-D). */
  readonly authoredTraceSha256: string;
  /** Digest of the resolved input the authored trace was simulated from. */
  readonly sourceInputDigest: string;
  readonly signalPrograms: readonly SignalProgram[];
  readonly roadControls?: readonly RoadControl[];
  readonly profile: ResolvedAmbientTrafficProfile;
  readonly network: SumoTrafficNetwork;
  readonly map: { readonly assetId: string; readonly versionId: string };
  /**
   * Who drives SUMO's traffic lights. `simforge` (the only production value)
   * rewrites tlLogic from the signal book; `netconvert` keeps the derivative's
   * own programs and exists solely so audits can show the difference.
   */
  readonly signalAuthority?: 'simforge' | 'netconvert';
}

export interface SumoTrafficKeyInput {
  readonly sourceInputDigest: string;
  readonly authoredTraceSha256: string;
  readonly sumoNetworkSha256: string;
  readonly runtime: Pick<SumoRuntime, 'version' | 'wasmSha256'>;
  readonly profile: ResolvedAmbientTrafficProfile;
  readonly stepSeconds: number;
  readonly durationSeconds: number;
  readonly signalAuthority?: 'simforge' | 'netconvert';
}

export interface SumoSignalAgreement {
  /** Controlled-link samples compared (links × clip steps). */
  readonly samples: number;
  /** Samples where SUMO's live link state differs from the SimForge book. */
  readonly mismatches: number;
  readonly firstMismatch: { readonly t: number; readonly tlId: string; readonly linkIndex: number; readonly expected: string; readonly actual: string } | null;
}

export interface SumoTrafficDiagnostics {
  readonly key: string;
  readonly couplingVersion: string;
  readonly runtime: { readonly version: string; readonly wasmSha256: string };
  readonly stepSeconds: number;
  readonly preRollSeconds: number;
  readonly clipSteps: number;
  readonly selectedRoutes: number;
  readonly nearbyRouteStarts: number;
  readonly peakActors: number;
  readonly uniqueActors: number;
  readonly networkExtentM: number;
  readonly float32UlpM: number;
  readonly signals: SumoSignalSynthesisReport;
  readonly signalAgreement: SumoSignalAgreement;
  /**
   * Clip ticks where the recorded signal book differs from the base program
   * (authored `set` overrides, preemption). SUMO follows the recorded book.
   */
  readonly signalOverrideTicks: number;
  /** Route candidates dropped for driving along authored lanes. */
  readonly authoredCorridorRejects: number;
  /**
   * SUMO teleports (collision/jam resolution) seen in the clip. A teleported
   * vehicle is split: its track ends at the jump and the remainder becomes a
   * new actor (`<id>~<n>`), so no rendered vehicle ever jumps.
   */
  readonly teleports: number;
  /** Steps where a vehicle moved > 0.25 m beyond its speed without teleporting (SUMO lane-shape seams). */
  readonly laneSeamJumps: number;
  /** Largest such seam jump, metres (derivative lane-registration quality). */
  readonly maxLaneSeamJumpM: number;
  /** Authored proxies SUMO could not insert (their spot overlapped another body); sorted. */
  readonly unplacedProxies: readonly string[];
  /** Edge carrying the proxy route (never used by ambient demand), or null. */
  readonly proxyRouteEdge: string | null;
  /** Distinct SUMO stderr lines (teleports, collisions, …), sorted. */
  readonly warnings: readonly string[];
}

export interface SumoTrafficResult {
  readonly key: string;
  readonly artifact: MaterializedTrafficArtifactEnvelope;
  readonly diagnostics: SumoTrafficDiagnostics;
}

export class SumoTrafficError extends Error {
  override readonly name = 'SumoTrafficError';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** H(resolvedInputDigest, authoredTrace, sumoNetSha, sumoBuild, profile, grid, couplingVersion). */
export function sumoTrafficKey(input: SumoTrafficKeyInput): string {
  return sha256(canonicalJson({
    schema: 'simforge.sumo-traffic-key/v1',
    couplingVersion: SUMO_TRAFFIC_COUPLING_VERSION,
    sourceInputDigest: input.sourceInputDigest,
    authoredTraceSha256: input.authoredTraceSha256,
    sumoNetworkSha256: input.sumoNetworkSha256,
    sumoBuild: { version: input.runtime.version, wasmSha256: input.runtime.wasmSha256 },
    profile: input.profile,
    stepSeconds: input.stepSeconds,
    durationSeconds: input.durationSeconds,
    preRollSeconds: SUMO_TRAFFIC_PRE_ROLL_SECONDS,
    ...(input.signalAuthority && input.signalAuthority !== 'simforge' ? { signalAuthority: input.signalAuthority } : {}),
  }));
}

/** Run the worker SUMO step. Pure in its inputs: same inputs, same bytes. */
export async function runSumoTraffic(runtime: SumoRuntime, input: SumoTrafficInput): Promise<SumoTrafficResult> {
  return (await prepareSumoTraffic(runtime)).run(input);
}

/** A fresh, single-use SUMO module, instantiated ahead so the run itself is synchronous. */
export interface PreparedSumoTraffic {
  readonly runtime: Pick<SumoRuntime, 'version' | 'wasmSha256'>;
  run(input: SumoTrafficInput): SumoTrafficResult;
}

export async function prepareSumoTraffic(runtime: SumoRuntime): Promise<PreparedSumoTraffic> {
  const stderr = new Set<string>();
  const module = await runtime.createModule((line) => {
    const trimmed = line.trim();
    // The lean build omits message catalogs and says so once per start.
    if (trimmed && !trimmed.includes('SUMO_HOME')) stderr.add(trimmed);
  });
  let used = false;
  return {
    runtime: { version: runtime.version, wasmSha256: runtime.wasmSha256 },
    run(input) {
      if (used) throw new SumoTrafficError('sumo_module_reused', 'a prepared SUMO module runs exactly once');
      used = true;
      return runSumoTrafficWithModule(module, runtime, stderr, input);
    },
  };
}

function runSumoTrafficWithModule(
  module: SumoWasmModule,
  runtime: Pick<SumoRuntime, 'version' | 'wasmSha256'>,
  stderr: Set<string>,
  input: SumoTrafficInput,
): SumoTrafficResult {
  const trace = input.authoredTrace;
  const dt = trace.header.dt;
  if (dt !== SUMO_TRAFFIC_STEP_SECONDS) {
    throw new SumoTrafficError('sumo_step_mismatch', `SUMO traffic runs on the ${SUMO_TRAFFIC_STEP_SECONDS} s grid; the trace uses ${dt} s`);
  }
  const frameCount = materializedTrafficFrameCount(dt, trace.header.clipSeconds);
  if (frameCount === null || trace.ticks.t.length !== frameCount) {
    throw new SumoTrafficError('sumo_trace_grid', 'authored trace ticks do not cover the clip on the fixed grid');
  }
  if (input.profile.preset === 'off') throw new SumoTrafficError('sumo_profile_off', 'ambient profile is off');
  const manifest = input.network.manifest;
  validateSumoNetworkManifest(manifest, manifest.mapId);
  const networkSha256 = sha256Bytes(input.network.bytes);
  if (networkSha256 !== manifest.sha256) {
    throw new SumoTrafficError('sumo_network_digest', `SUMO network bytes ${networkSha256} do not match the sidecar ${manifest.sha256}`);
  }
  const networkXml = new TextDecoder().decode(input.network.bytes);
  const extent = networkExtent(networkXml);
  const ulp = float32Ulp(extent);
  if (!(ulp <= SUMO_TRAFFIC_MAX_FLOAT32_ULP_M)) {
    throw new SumoTrafficError('sumo_float32_extent', `SUMO network extent ${extent} m exceeds float32 precision budget`);
  }
  const transform = manifest.worldFromNetwork;
  const key = sumoTrafficKey({
    sourceInputDigest: input.sourceInputDigest,
    authoredTraceSha256: input.authoredTraceSha256,
    sumoNetworkSha256: networkSha256,
    runtime,
    profile: input.profile,
    stepSeconds: dt,
    durationSeconds: trace.header.clipSeconds,
    signalAuthority: input.signalAuthority ?? 'simforge',
  });

  const sceneTrace = traceToSceneFrame(trace);
  const clipSteps = frameCount - 1;
  const preRollSteps = Math.round(SUMO_TRAFFIC_PRE_ROLL_SECONDS / dt);
  const totalSteps = preRollSteps + clipSteps;

  // Signals: SUMO step j spans scene time [T0 + j·dt, T0 + (j+1)·dt) with
  // T0 = -preRoll. Clip steps read the engine's own recorded phase at the
  // step's start tick; pre-roll steps evaluate the same program formula.
  const warmupSeconds = trace.header.warmupSeconds;
  let signalOverrideTicks = 0;
  const recorded = trace.ticks.signals ?? {};
  for (const program of input.signalPrograms) {
    const track = recorded[program.id];
    if (!track) continue;
    track.phase.forEach((phase, index) => {
      if (phase !== signalProgramIndicationAt(program, trace.ticks.t[index]!, warmupSeconds)) signalOverrideTicks += 1;
    });
  }
  const indicationAt = (program: SignalProgram, step: number) => {
    const tick = step - preRollSteps;
    const track = recorded[program.id];
    if (tick >= 0 && track && tick < track.phase.length) return track.phase[tick]!;
    return signalProgramIndicationAt(program, (step - preRollSteps) * dt, warmupSeconds);
  };
  const synthesis = synthesizeSumoSignalPrograms(networkXml, input.signalPrograms, {
    stepSeconds: dt,
    stepCount: totalSteps + 1,
    indication: indicationAt,
    roadControls: input.roadControls ?? [],
  });
  const signalNetwork = parseSumoSignalNetwork(synthesis.xml);
  const expectedLinkState = expectedLinkStates(signalNetwork, synthesis, input.signalPrograms, indicationAt);

  const roads = buildSumoRoadOccupancyIndex(networkXml, transform);
  const focuses = demandFocuses(sceneTrace);
  const corridor = sumoEdgesForRoadLanes(networkXml, authoredCorridorLanes(trace));
  const proxyEdge = sumoIsolatedProxyEdge(networkXml, manifest.routeCandidates);
  const demand = planSumoDemand(manifest.routeCandidates, networkXml, transform, input.profile, focuses, {
    ...SUMO_DEMAND_ROUTE_OPTIONS,
    vehicleDimensions: {
      lengthM: SUMO_TRAFFIC_VEHICLE.dims.l,
      widthM: SUMO_TRAFFIC_VEHICLE.dims.w,
      heightM: SUMO_TRAFFIC_VEHICLE.dims.h,
    },
    ...(proxyEdge ? { proxyRouteEdges: [proxyEdge] } : {}),
  }, corridor);

  const session = new SumoWasmSession(module);
  const recorder = new MaterializedTrafficRecorder({
    sourceInputDigest: input.sourceInputDigest,
    map: { assetId: input.map.assetId, versionId: input.map.versionId },
    provider: { id: 'sumo', version: runtime.version, seed: String(input.profile.seed) },
    fixedStepSeconds: dt,
    durationSeconds: trace.header.clipSeconds,
  });
  const mirrored = new Map<string, SumoExternalProxy>();
  const unplaced = new Set<string>();
  let peakActors = 0;
  let samples = 0;
  let mismatches = 0;
  let firstMismatch: SumoSignalAgreement['firstMismatch'] = null;
  const uniqueActors = new Set<string>();
  const continuity = new SumoTrackContinuity(dt);
  try {
    session.start(
      new TextEncoder().encode(input.signalAuthority === 'netconvert' ? networkXml : synthesis.xml),
      new TextEncoder().encode(demand.routeDocument),
      dt,
      sumoNumericSeed(input.profile.seed),
    );
    // Pre-roll: authored actors held at t = 0.
    const held = proxiesAt(sceneTrace, 0, transform, roads, true);
    for (let step = 0; step < preRollSteps; step += 1) {
      mirror(session, mirrored, unplaced, held);
      session.step(dt);
    }
    const record = (tick: number) => {
      const actors = continuity.apply(sceneActors(session, transform));
      peakActors = Math.max(peakActors, actors.length);
      actors.forEach((actor) => uniqueActors.add(actor.id));
      recorder.record({ t: recorder.nextTime, actors, signals: {} });
      if (tick > 0) {
        const expected = expectedLinkState(preRollSteps + tick - 1);
        for (const link of session.signalLinks()) {
          const want = expected.get(`${link.controllerHash}:${link.linkIndex}`);
          if (want === undefined) continue;
          samples += 1;
          if (want.state !== link.state) {
            mismatches += 1;
            firstMismatch ??= { t: trace.ticks.t[tick]!, tlId: want.tlId, linkIndex: link.linkIndex, expected: want.state, actual: link.state };
          }
        }
      }
    };
    record(0);
    for (let tick = 1; tick < frameCount; tick += 1) {
      mirror(session, mirrored, unplaced, proxiesAt(sceneTrace, trace.ticks.t[tick]!, transform, roads, false));
      session.step(dt);
      record(tick);
    }
  } finally {
    session.close();
  }
  const artifact = recorder.finalize();
  return {
    key,
    artifact,
    diagnostics: {
      key,
      couplingVersion: SUMO_TRAFFIC_COUPLING_VERSION,
      runtime: { version: runtime.version, wasmSha256: runtime.wasmSha256 },
      stepSeconds: dt,
      preRollSeconds: SUMO_TRAFFIC_PRE_ROLL_SECONDS,
      clipSteps,
      selectedRoutes: demand.selectedRoutes,
      nearbyRouteStarts: demand.nearbyRouteStarts,
      peakActors,
      uniqueActors: uniqueActors.size,
      networkExtentM: extent,
      float32UlpM: ulp,
      signals: synthesis.report,
      signalAgreement: { samples, mismatches, firstMismatch },
      signalOverrideTicks,
      authoredCorridorRejects: demand.authoredCorridorRejects,
      teleports: continuity.teleports,
      unplacedProxies: [...unplaced].sort(compare),
      proxyRouteEdge: proxyEdge,
      laneSeamJumps: continuity.discontinuities,
      maxLaneSeamJumpM: continuity.maxDiscontinuityM,
      warnings: [...stderr].sort(),
    },
  };
}

/** Authored proxies at scene time `t`, network frame, sorted by id. */
function proxiesAt(
  trace: ReturnType<typeof traceToSceneFrame>,
  t: number,
  transform: SumoNetworkWorldTransform,
  roads: ReturnType<typeof buildSumoRoadOccupancyIndex>,
  hold: boolean,
): SumoExternalProxy[] {
  return sumoAuthoredOccupanciesAt(trace, t, roads)
    .map((occupancy) => {
      const network = sumoSceneToNetwork({ x: occupancy.x, z: occupancy.z }, transform);
      return {
        id: `external:${occupancy.id}`,
        kind: occupancy.kind,
        routeId: 'proxy-route',
        x: network.x,
        y: network.y,
        headingDegrees: sumoSceneHeadingToNetwork(occupancy.headingRad * 180 / Math.PI + 90, transform),
        speedMps: hold ? 0 : occupancy.speedMps,
        lengthM: occupancy.lengthM,
        widthM: occupancy.widthM,
      } satisfies SumoExternalProxy;
    })
    .sort((left, right) => compare(left.id, right.id));
}

/** Remove proxies that disappeared, then upsert changed ones, all in id order. */
/**
 * Remove proxies that disappeared, then upsert changed ones, all in id order.
 *
 * The bridge adds a proxy once and moves it with moveToXY. When SUMO cannot
 * insert it (its spot overlaps another body), the vehicle stays pending: it is
 * not in the network, so the bridge would try to add it again and fail. Such a
 * proxy is recorded as unplaced and never upserted again; it can only ever be
 * inserted on the isolated proxy route.
 */
function mirror(
  session: SumoWasmSession,
  mirrored: Map<string, SumoExternalProxy>,
  unplaced: Set<string>,
  proxies: readonly SumoExternalProxy[],
): void {
  const current = new Set(proxies.map((proxy) => proxy.id));
  for (const id of [...mirrored.keys()].sort(compare)) {
    if (current.has(id)) continue;
    session.remove(id);
    mirrored.delete(id);
  }
  for (const proxy of proxies) {
    if (unplaced.has(proxy.id) || sameProxy(mirrored.get(proxy.id), proxy)) continue;
    try {
      session.upsert(proxy);
      mirrored.set(proxy.id, proxy);
    } catch (error) {
      if (!(error instanceof Error) || !/to add already exists/.test(error.message)) throw error;
      unplaced.add(proxy.id);
      mirrored.delete(proxy.id);
    }
  }
}

function sameProxy(previous: SumoExternalProxy | undefined, next: SumoExternalProxy): boolean {
  return previous !== undefined
    && previous.kind === next.kind && previous.x === next.x && previous.y === next.y
    && previous.headingDegrees === next.headingDegrees && previous.speedMps === next.speedMps
    && previous.lengthM === next.lengthM && previous.widthM === next.widthM;
}

/** SUMO-driven vehicles in the scene frame, quantized, sorted by id. */
function sceneActors(session: SumoWasmSession, transform: SumoNetworkWorldTransform): MaterializedTrafficFrameActor[] {
  const actors = session.vehicles().map((vehicle) => {
    const scene = sumoNetworkToScene({ x: vehicle.x, y: vehicle.y }, transform);
    const headingDegrees = sumoNetworkHeadingToScene(vehicle.headingDegrees, transform);
    return {
      id: sumoTrafficActorId(vehicle.idHash),
      kind: 'vehicle' as const,
      x: quantize(scene.x, SUMO_TRAFFIC_POSITION_QUANTUM_M),
      z: quantize(scene.z, SUMO_TRAFFIC_POSITION_QUANTUM_M),
      headingRad: quantize(wrapRadians((headingDegrees - 90) * Math.PI / 180), SUMO_TRAFFIC_ANGLE_QUANTUM_RAD),
      speedMps: quantize(Math.max(0, vehicle.speedMps), SUMO_TRAFFIC_SPEED_QUANTUM),
      accelerationMps2: quantize(vehicle.accelerationMps2, SUMO_TRAFFIC_SPEED_QUANTUM),
      signals: vehicle.signals >>> 0,
    };
  });
  actors.sort((left, right) => compare(left.id, right.id));
  for (let index = 1; index < actors.length; index += 1) {
    if (actors[index - 1]!.id === actors[index]!.id) {
      throw new SumoTrafficError('sumo_id_hash_collision', `two SUMO vehicles hash to ${actors[index]!.id}`);
    }
  }
  return actors;
}

/**
 * Splits a SUMO vehicle's track wherever it did not move continuously: a
 * position jump larger than any speed it reported allows, or a reappearance
 * after it vanished (SUMO teleports on collision or jam). The part after the
 * jump is recorded as a new actor, so every recorded track is continuous.
 */
class SumoTrackContinuity {
  private readonly last = new Map<string, { x: number; z: number; speedMps: number; frame: number; segment: number }>();
  private frame = -1;
  teleports = 0;
  /** Continuous-track steps that still moved > 0.25 m beyond their speed (lane-shape seams). */
  discontinuities = 0;
  maxDiscontinuityM = 0;

  constructor(private readonly dt: number) {}

  apply(actors: readonly MaterializedTrafficFrameActor[]): MaterializedTrafficFrameActor[] {
    this.frame += 1;
    const result = actors.map((actor) => {
      const previous = this.last.get(actor.id);
      let segment = previous?.segment ?? 0;
      if (previous && previous.frame === this.frame - 1) {
        const moved = Math.sqrt((actor.x - previous.x) ** 2 + (actor.z - previous.z) ** 2);
        const excess = moved - previous.speedMps * this.dt;
        if (excess > 0.25) {
          this.discontinuities += 1;
          this.maxDiscontinuityM = Math.max(this.maxDiscontinuityM, Math.round(excess * 1e3) / 1e3);
        }
      }
      if (previous) {
        // Registered SUMO lane shapes can meet with a seam of a few metres
        // (see laneSeamJumps); a SUMO teleport moves a vehicle to another
        // edge. Only a jump beyond any seam plus the distance any reported
        // speed covers is treated as a teleport.
        const reach = Math.max(previous.speedMps, actor.speedMps) * this.dt * (this.frame - previous.frame) * 1.5 + SUMO_TRAFFIC_TELEPORT_MARGIN_M;
        const dx = actor.x - previous.x;
        const dz = actor.z - previous.z;
        if (previous.frame !== this.frame - 1 || dx * dx + dz * dz > reach * reach) {
          segment += 1;
          this.teleports += 1;
        }
      }
      this.last.set(actor.id, { x: actor.x, z: actor.z, speedMps: actor.speedMps, frame: this.frame, segment });
      return segment === 0 ? actor : { ...actor, id: `${actor.id}~${segment}` };
    });
    return result.sort((left, right) => compare(left.id, right.id));
  }
}

/** Trace id of a SUMO vehicle: its bridge FNV-1a hash, stable across identical runs. */
export function sumoTrafficActorId(idHash: number): string {
  return `sumo:${(idHash >>> 0).toString(16).padStart(8, '0')}`;
}

/** The trace id a SUMO vehicle id (`sumo-<seed>-<n>` or a flow member) will carry. */
export function sumoTrafficActorIdFor(sumoVehicleId: string): string {
  return sumoTrafficActorId(sumoIdHash(sumoVehicleId));
}

/** Every lane a moving authored actor occupies during the clip. */
function authoredCorridorLanes(trace: SimTrace): string[] {
  const lanes = new Set<string>();
  for (const [id, track] of Object.entries(trace.ticks.actors)) {
    if (trace.header.actorMetadata?.[id]?.static) continue;
    if (!track.speedMps.some((speed) => speed > 0.1)) continue;
    track.laneRsl.forEach((lane, index) => {
      if (lane && track.present[index] === 1) lanes.add(lane);
    });
  }
  return [...lanes].sort(compare);
}

/** Demand focuses: present, moving authored actors at t = 0, sorted by id. */
function demandFocuses(trace: ReturnType<typeof traceToSceneFrame>): { x: number; z: number }[] {
  return Object.keys(trace.ticks.actors).sort(compare).flatMap((id) => {
    const track = trace.ticks.actors[id]!;
    if (track.present[0] !== 1 || trace.header.actorMetadata?.[id]?.static) return [];
    return [{ x: track.x[0]!, z: track.z[0]! }];
  });
}

/** Expected live SUMO link state during step `step`, keyed `controllerHash:linkIndex`. */
function expectedLinkStates(
  network: ReturnType<typeof parseSumoSignalNetwork>,
  synthesis: ReturnType<typeof synthesizeSumoSignalPrograms>,
  programs: readonly SignalProgram[],
  indication: (program: SignalProgram, step: number) => ReturnType<typeof signalProgramIndicationAt>,
): (step: number) => Map<string, { tlId: string; state: string }> {
  const byId = new Map(programs.map((program) => [program.id, program]));
  const bindings = synthesis.bindings.filter((binding) => binding.programIds.length > 0);
  const linkCount = new Map(network.trafficLights.map((logic) => [logic.id, logic.linkCount]));
  return (step) => {
    const map = new Map<string, { tlId: string; state: string }>();
    for (const binding of bindings) {
      if (binding.linkIndex >= (linkCount.get(binding.tlId) ?? 0)) continue;
      const states = binding.programIds.map((id) => {
        const program = byId.get(id)!;
        return sumoLinkStateForIndication(indication(program, step), program.darkFallback);
      });
      const order = ['r', 'y', 's', 'o', 'g', 'G', 'O'];
      const state = states.sort((left, right) => order.indexOf(left) - order.indexOf(right))[0]!;
      map.set(`${sumoIdHash(binding.tlId)}:${binding.linkIndex}`, { tlId: binding.tlId, state });
    }
    return map;
  };
}

function networkExtent(networkXml: string): number {
  const boundary = /<location\b[^>]*\bconvBoundary="([^"]+)"/.exec(networkXml)?.[1];
  const values = boundary?.split(',').map(Number) ?? [];
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new SumoTrafficError('sumo_network_location', 'SUMO network has no convBoundary');
  }
  return Math.max(...values.map(Math.abs));
}

/** Spacing of float32 values at magnitude `value`. */
function float32Ulp(value: number): number {
  if (value < 2 ** -126) return 2 ** -149;
  return 2 ** (Math.floor(Math.log2(value)) - 23);
}

function quantize(value: number, quantum: number): number {
  const scaled = Math.round(value / quantum);
  return scaled === 0 ? 0 : scaled * quantum === 0 ? 0 : Number((scaled * quantum).toFixed(decimals(quantum)));
}

function decimals(quantum: number): number {
  return Math.max(0, Math.round(-Math.log10(quantum)));
}

/** Arithmetic-only wrap into [-π, π]: no transcendental call, identical everywhere. */
function wrapRadians(value: number): number {
  const turn = 2 * Math.PI;
  return value - turn * Math.round(value / turn);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
