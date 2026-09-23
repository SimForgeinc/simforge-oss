import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

import type { LaneGraph } from '@simforge-oss/engine';
import type { EnvAction } from '@simforge-oss/training-env';

import { ModelSocketClient, repositoryRoot, stopProcess } from '../model-socket.js';
import type { Policy, PolicyDecision, PolicyObservation, SessionActorSnapshot } from '../policy.js';
import type { ReasoningRecord } from '@simforge-oss/evaluation/drive-evidence';
import { localToWorld, worldToLocal, type PlanPoint } from './trajectory.js';

const SERVICE_TIMEOUT_MS = 1_300;
const DECISION_HZ = 3;
const PERCEPTION_RANGE_M = 120;
const QUANTUM_M = 0.1;
const QUANTUM_MPS = 0.1;
const QUANTUM_RAD = 0.01;
const QUANTUM_ACCEL_MPS2 = 0.1;
const QUANTUM_TIME_S = 0.02;
const MAX_OBJECTS = 24;
const ROUTE_BACK_M = 6;
const ROUTE_SAMPLE_M = 2;
const EGO_LENGTH_M = 4.5;
const EGO_WIDTH_M = 1.9;
const DEFAULT_LANE_WIDTH_M = 3.5;

const QUESTION = 'Select one listed code-vetted maneuver for the next interval. Be a cooperative driver: make useful progress toward the cruise target, smoothly match slower traffic and create space when closing, but avoid needless braking. Every listed candidate is already feasible under the deterministic safety envelope. Use only this observed scene and never infer hidden actors or another driver’s intentions.';

type Vec2 = { x: number; y: number };
type ActorDims = { lengthM: number; widthM: number };
type SceneObject = Record<string, unknown>;
interface LaneContext {
  widthM: number;
  speedLimitMps: number | null;
  source: string;
  rsl: string | null;
  laneS: number | null;
}

interface DecisionResponse {
  latched_maneuver?: string;
  jev_choice?: string | null;
  probabilities?: Record<string, number>;
  confidence?: number | null;
  fallback_reason?: string | null;
  api_latency_ms?: number | null;
  points?: number[][] | null;
  feasible?: string[];
  rejected?: Record<string, string>;
  api_call?: boolean;
  api_call_count?: number;
  scene_validated?: boolean;
  schema_version?: string;
  error?: string;
  plan?: Record<string, unknown>;
  health?: Record<string, unknown>;
}

function quantize(value: number, quantum: number): number {
  return Number((Math.round(value / quantum) * quantum).toFixed(6));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asNumber(value: unknown, fallback: number): number {
  return finite(value) ? value : fallback;
}

function wrap(angle: number): number {
  return (angle + Math.PI) % (2 * Math.PI) - Math.PI;
}

function rotate(x: number, y: number, yaw: number): Vec2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: c * x + s * y, y: -s * x + c * y };
}

function worldVelocity(actor: SessionActorSnapshot): Vec2 {
  return { x: actor.speedMps * Math.cos(actor.yawRad), y: actor.speedMps * Math.sin(actor.yawRad) };
}

function dimsForKind(kind: string): ActorDims {
  const normalized = kind.toLowerCase();
  if (normalized.includes('truck')) return { lengthM: 10, widthM: 2.6 };
  if (normalized.includes('bus')) return { lengthM: 12, widthM: 2.6 };
  if (normalized.includes('motorcycle')) return { lengthM: 2.2, widthM: 0.9 };
  if (normalized.includes('bicycle')) return { lengthM: 1.8, widthM: 0.7 };
  if (normalized.includes('pedestrian')) return { lengthM: 0.7, widthM: 0.7 };
  return { lengthM: EGO_LENGTH_M, widthM: EGO_WIDTH_M };
}

/** Segment-vs-OBB gate equivalent to the adapter's physical line-of-sight check. */
function segmentHitsBox(start: Vec2, end: Vec2, center: Vec2, heading: number, lengthM: number, widthM: number): boolean {
  const a = rotate(start.x - center.x, start.y - center.y, -heading);
  const b = rotate(end.x - center.x, end.y - center.y, -heading);
  if (Math.abs(a.x) <= lengthM / 2 && Math.abs(a.y) <= widthM / 2) return true;
  if (Math.abs(b.x) <= lengthM / 2 && Math.abs(b.y) <= widthM / 2) return true;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let enter = 0;
  let leave = 1;
  for (const [origin, direction, extent] of [[a.x, dx, lengthM / 2], [a.y, dy, widthM / 2]] as const) {
    if (Math.abs(direction) < 1e-9) {
      if (origin < -extent || origin > extent) return false;
      continue;
    }
    const t0 = (-extent - origin) / direction;
    const t1 = (extent - origin) / direction;
    enter = Math.max(enter, Math.min(t0, t1));
    leave = Math.min(leave, Math.max(t0, t1));
    if (enter > leave) return false;
  }
  return leave >= 0 && enter <= 1;
}


function egoAcceleration(obs: PolicyObservation): number {
  const current = obs.egoHistory.at(-1);
  const previous = obs.egoHistory.at(-2);
  if (!current || !previous) return 0;
  const dt = current[4]! - previous[4]!;
  return dt > 1e-6 ? (current[3]! - previous[3]!) / dt : 0;
}

function parseLane(graph: LaneGraph, rsl: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(graph.laneJson(rsl));
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function laneContext(obs: PolicyObservation): LaneContext {
  const hit = obs.graph.nearestLane(obs.pose.x, obs.pose.y, 25);
  if (!hit) return { widthM: DEFAULT_LANE_WIDTH_M, speedLimitMps: null, source: `map:${obs.mapId}:no-nearest-lane`, rsl: null, laneS: null };
  const [rsl, laneS] = hit;
  const lane = parseLane(obs.graph, rsl);
  const speedLimitKph = lane['speedLimitKph'];
  const widthM = asNumber(obs.graph.laneWidthAt(rsl, laneS), asNumber(lane['representativeWidthM'], DEFAULT_LANE_WIDTH_M));
  const speedLimitMps = finite(speedLimitKph) ? speedLimitKph / 3.6 : null;
  return { widthM, speedLimitMps, source: `map:${obs.mapId}:lane:${rsl}`, rsl, laneS };
}

/** The runner's world-frame route ahead, extended `ROUTE_BACK_M` behind its first sample. */
function routeCenterline(obs: PolicyObservation): number[][] {
  const forward = obs.route.points.filter((point) => finite(point[0]) && finite(point[1])).map((point) => [point[0]!, point[1]!]);
  if (forward.length < 2) return forward;
  const first = forward[0]!;
  const distanceFromEgo = Math.hypot(first[0]! - obs.pose.x, first[1]! - obs.pose.y);
  const points = distanceFromEgo > 1 ? [[obs.pose.x, obs.pose.y], ...forward] : forward;
  const anchor = points[0]!;
  const next = points[1]!;
  const dx = next[0]! - anchor[0]!;
  const dy = next[1]! - anchor[1]!;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-6) return points;
  const back = [];
  for (let distance = ROUTE_BACK_M; distance >= ROUTE_SAMPLE_M; distance -= ROUTE_SAMPLE_M) {
    back.push([anchor[0]! - dx / length * distance, anchor[1]! - dy / length * distance]);
  }
  return [...back, ...points];
}

function routeDirectionSign(points: readonly number[][], pose: PolicyObservation['pose']): -1 | 1 {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current || !finite(previous[0]) || !finite(previous[1]) || !finite(current[0]) || !finite(current[1])) continue;
    const dx = current[0]! - previous[0]!;
    const dy = current[1]! - previous[1]!;
    if (Math.hypot(dx, dy) <= 1e-6) continue;
    return dx * Math.cos(pose.yawRad) + dy * Math.sin(pose.yawRad) < 0 ? -1 : 1;
  }
  return 1;
}

function sceneObject(obs: PolicyObservation, actor: SessionActorSnapshot, dims: ActorDims, local: Vec2, relativeVelocity: Vec2, timeS: number): SceneObject {
  const range = Math.hypot(local.x, local.y);
  const heading = wrap(actor.yawRad - obs.pose.yawRad);
  const rangeRate = (local.x * relativeVelocity.x + local.y * relativeVelocity.y) / Math.max(1e-7, range);
  return {
    track_id: actor.id,
    class: actor.kind,
    x_m: quantize(local.x, QUANTUM_M),
    y_m: quantize(local.y, QUANTUM_M),
    rel_vx_mps: quantize(relativeVelocity.x, QUANTUM_MPS),
    rel_vy_mps: quantize(relativeVelocity.y, QUANTUM_MPS),
    range_m: quantize(range, QUANTUM_M),
    bearing_rad: quantize(Math.atan2(local.y, local.x), QUANTUM_RAD),
    range_rate_mps: quantize(rangeRate, QUANTUM_MPS),
    heading_rad: quantize(heading, QUANTUM_RAD),
    length_m: quantize(dims.lengthM, QUANTUM_M),
    width_m: quantize(dims.widthM, QUANTUM_M),
    existence_probability: 1,
    position_cov_m2: [0, 0, 0],
    velocity_cov_m2ps2: [0, 0, 0],
    detection_score: null,
    class_probabilities: null,
    track_status: 'confirmed',
    source: 'simforge-visible-box-sensor',
    uncertainty_source: 'exact_simulator_state',
    measurement_age_s: 0,
    track_age_s: quantize(Math.max(0, timeS), QUANTUM_TIME_S),
    state_time_s: quantize(timeS, QUANTUM_TIME_S),
    last_observed_time_s: quantize(timeS, QUANTUM_TIME_S),
  };
}

function makeScene(obs: PolicyObservation): { scene: Record<string, unknown>; omittedOccludedObjects: number } {
  const egoActor = obs.actors.find((actor) => actor.id === obs.egoId);
  const egoDims = egoActor ? dimsForKind(egoActor.kind) : { lengthM: EGO_LENGTH_M, widthM: EGO_WIDTH_M };
  const context = laneContext(obs);
  const worldObjects = obs.actors.filter((actor) => actor.present && actor.id !== obs.egoId && Math.hypot(actor.x - obs.pose.x, actor.y - obs.pose.y) <= PERCEPTION_RANGE_M);
  let omittedOccludedObjects = 0;
  const visible: SceneObject[] = [];
  for (const actor of worldObjects) {
    const targetCenter = { x: actor.x, y: actor.y };
    const blocked = worldObjects.some((other) => {
      if (other === actor) return false;
      const otherDims = dimsForKind(other.kind);
      return segmentHitsBox({ x: obs.pose.x, y: obs.pose.y }, targetCenter, { x: other.x, y: other.y }, other.yawRad, otherDims.lengthM, otherDims.widthM);
    });
    if (blocked) {
      omittedOccludedObjects += 1;
      continue;
    }
    const relativePosition = rotate(actor.x - obs.pose.x, actor.y - obs.pose.y, obs.pose.yawRad);
    const actorVelocity = worldVelocity(actor);
    const egoVelocity = { x: obs.pose.speedMps * Math.cos(obs.pose.yawRad), y: obs.pose.speedMps * Math.sin(obs.pose.yawRad) };
    const relativeVelocity = rotate(actorVelocity.x - egoVelocity.x, actorVelocity.y - egoVelocity.y, obs.pose.yawRad);
    visible.push(sceneObject(obs, actor, dimsForKind(actor.kind), relativePosition, relativeVelocity, obs.tS));
  }
  visible.sort((a, b) => Number(a['range_m']) - Number(b['range_m']) || String(a['track_id']).localeCompare(String(b['track_id'])));
  const omittedObjects = Math.max(0, visible.length - MAX_OBJECTS);
  const objects = visible.slice(0, MAX_OBJECTS);
  const worldRoute = routeCenterline(obs);
  const signedSpeedMps = Math.max(0, obs.pose.speedMps) * routeDirectionSign(worldRoute, obs.pose);
  const centerline = worldRoute.flatMap((point) => {
    const x = point[0];
    const y = point[1];
    if (!finite(x) || !finite(y)) return [];
    const [localX, localY] = worldToLocal([x, y], obs.pose);
    return [[quantize(localX, QUANTUM_M), quantize(localY, QUANTUM_M)]];
  });
  const scene: Record<string, unknown> = {
    schema_version: 'scene-observation/v2',
    seq: Math.max(0, Math.trunc(obs.step)),
    state_time_s: quantize(obs.tS, QUANTUM_TIME_S),
    last_observed_time_s: quantize(obs.tS, QUANTUM_TIME_S),
    frame: 'ego-flu',
    provider: { name: 'simforge-native-visible-boxes', version: '1', kind: 'ground_truth' },
    capabilities: {
      profile: 'planar-tracked-objects',
      supplied: ['ego.speed_mps', 'ego.longitudinal_velocity_mps', 'objects.class', 'objects.length_m', 'objects.width_m', 'objects.rel_vx_mps', 'objects.rel_vy_mps', 'objects.x_m', 'objects.y_m', 'objects.range_rate_mps', 'route.speed_limit_mps', 'coverage.unknown_regions_m', 'candidates'],
      unsupported: [],
    },
    uncertainty_layout: {
      frame: 'ego-flu', position_order: ['xx', 'xy', 'yy'], velocity_order: ['vxvx', 'vxvy', 'vyvy'], packing: 'upper_triangle', position_units: 'm^2', velocity_units: 'm^2/s^2', conditioning: 'given existence; cross position-velocity covariance omitted',
    },
    calibration: { status: 'calibrated', method: 'exact_simulator_state', model_version: 'native-session', calibration_domain: 'simulated-measurement', calibration_dataset: null, calibration_version: 'exact-no-statistical-fit' },
    ego: {
      speed_mps: quantize(Math.max(0, obs.pose.speedMps), QUANTUM_MPS),
      accel_mps2: quantize(egoAcceleration(obs), QUANTUM_ACCEL_MPS2),
      length_m: quantize(egoDims.lengthM, QUANTUM_M),
      width_m: quantize(egoDims.widthM, QUANTUM_M),
      longitudinal_velocity_mps: quantize(signedSpeedMps, QUANTUM_MPS),
      longitudinal_velocity_source: 'native-forward-drive-route-heading',
      cruise_speed_mps: context.speedLimitMps,
    },
    route: {
      centerline_m: centerline,
      width_m: quantize(context.widthM, QUANTUM_M),
      speed_limit_mps: context.speedLimitMps === null ? null : quantize(context.speedLimitMps, QUANTUM_MPS),
      required_stop_m: null,
      source: context.source,
      complete: centerline.length >= 2,
    },
    coverage: {
      radius_m: PERCEPTION_RANGE_M,
      complete: omittedObjects === 0,
      omitted_objects: omittedObjects,
      measurement_age_s: 0,
      unknown_regions_m: [],
      untracked_occupied_regions_m: [],
      observed_free_regions_m: null,
      frame: 'ego-flu',
      vertical_bounds_m: null,
      state_time_s: quantize(obs.tS, QUANTUM_TIME_S),
      source: 'native-visible-boxes-and-actor-occlusion',
      geometry: 'rectangles:[center_x,center_y,length,width]',
    },
    // Exact current infrastructure state; no unknown phase is inferred green.
    ...(obs.nativeObservation?.signals ? { signals: obs.nativeObservation.signals } : {}),
    objects,
  };
  return { scene, omittedOccludedObjects };
}

/** Jev's vetted candidate is a timestamped ego-frame `[x, y, heading, speed, t]` plan. */
function anchorPlan(points: number[][] | null | undefined, obs: PolicyObservation): PlanPoint[] {
  return (points ?? []).filter((point) => point.length >= 5 && point.every(finite)).map((point) => {
    const [x, y] = localToWorld(point, obs.pose);
    return { x, y, headingRad: obs.pose.yawRad + point[2]!, speedMps: point[3]!, tS: point[4]! };
  });
}

function safeAction(obs: PolicyObservation): EnvAction {
  const preview = obs.route.points.find((point) => Array.isArray(point) && finite(point[0]) && finite(point[1])) ?? [obs.pose.x + 3 * Math.cos(obs.pose.yawRad), obs.pose.y + 3 * Math.sin(obs.pose.yawRad)];
  return {
    motionDirection: 1,
    targetSpeedMps: 0,
    targetAccelerationMps2: -5,
    previewPoint: { x: preview[0]!, y: preview[1]! },
    previewHeadingRad: obs.pose.yawRad,
  };
}

function actionFromPlan(points: readonly PlanPoint[], obs: PolicyObservation, issuedTS: number): EnvAction {
  if (points.length === 0) return safeAction(obs);
  const ageS = Math.max(0, obs.tS - issuedTS);
  const target = points.find((point) => point.tS + 1e-9 >= ageS + 0.1) ?? points.at(-1)!;
  const preview = points.find((point) => point.tS + 1e-9 >= ageS + 0.35) ?? points.at(-1)!;
  return {
    motionDirection: target.speedMps < 0 ? -1 : 1,
    targetSpeedMps: Math.max(0, target.speedMps),
    targetAccelerationMps2: (target.speedMps - obs.pose.speedMps) / Math.max(0.1, target.tS - ageS),
    previewPoint: { x: preview.x, y: preview.y },
    previewHeadingRad: preview.headingRad,
  };
}

function fallbackReasoning(response: DecisionResponse, action: EnvAction): ReasoningRecord {
  const probabilities = response.probabilities && typeof response.probabilities === 'object' ? response.probabilities : {};
  const candidates = Array.isArray(response.feasible) ? response.feasible.filter((value): value is string => typeof value === 'string') : Object.keys(probabilities);
  const choice = typeof response.jev_choice === 'string' ? response.jev_choice : (typeof response.latched_maneuver === 'string' ? response.latched_maneuver : action.targetSpeedMps === 0 ? 'emergency_brake' : 'hold');
  return { kind: 'choice', question: QUESTION, choice, probabilities, confidence: typeof response.confidence === 'number' && Number.isFinite(response.confidence) ? response.confidence : null, candidates };
}

function pythonExecutable(adapterRoot: string): string {
  const candidates = [
    process.env['SIMFORGE_JEV_PYTHON'],
    path.join(adapterRoot, '.venv', 'bin', 'python'),
    process.env['VIRTUAL_ENV'] ? path.join(process.env['VIRTUAL_ENV'], 'bin', 'python') : undefined,
    'python3',
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => candidate === 'python3' || existsSync(candidate)) ?? 'python3';
}

export class JevPolicy implements Policy {
  readonly id = 'jev';
  readonly cameraProfile = 'none';
  readonly historyFrames = 0;
  private child: ChildProcess | undefined;
  private endpoint: ModelSocketClient | undefined;
  private socketPath: string | undefined;
  private log: (line: string) => void = () => undefined;
  private held: PolicyDecision | undefined;
  private heldPlan: PlanPoint[] = [];
  private heldAtTS = 0;
  private nextDecisionTS = Number.NEGATIVE_INFINITY;
  private stopped = false;
  constructor(readonly replanHz = DECISION_HZ) {
    if (!Number.isFinite(replanHz) || replanHz <= 0) throw new Error('Jev replan cadence must be positive');
  }

  async start(ctx: { mapId: string; graph: LaneGraph; out: string; log: (line: string) => void }): Promise<{ hello: unknown }> {
    const laneCount = Number((ctx.graph as LaneGraph & { laneCount?: number }).laneCount ?? ctx.graph.laneIds.length);
    if (!Number.isFinite(laneCount) || laneCount <= 0 || ctx.graph.laneIds.length === 0) throw new Error(`Jev requires a lane graph for ${ctx.mapId}`);
    this.log = ctx.log;
    this.stopped = false;
    this.held = undefined;
    this.heldPlan = [];
    this.nextDecisionTS = Number.NEGATIVE_INFINITY;
    const adapterRoot = path.join(repositoryRoot(), 'adapters', 'jev-driver');
    this.socketPath = path.join(os.tmpdir(), `simforge-jev-${process.pid}-${Date.now()}.sock`);
    const child = spawn(pythonExecutable(adapterRoot), ['-m', 'jevdrive', 'serve', '--socket', this.socketPath], {
      cwd: adapterRoot,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH: [path.join(adapterRoot, '../policy-endpoint'), process.env['PYTHONPATH']].filter(Boolean).join(path.delimiter) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      let output = '';
      const onOutput = (chunk: Buffer, stream: string): void => {
        output += chunk.toString();
        const lines = output.split(/\r?\n/);
        output = lines.pop() ?? '';
        for (const line of lines) {
          this.log(`[jev-service:${stream}] ${line}`);
          if (line.startsWith('READY socket=')) resolve();
        }
      };
      child.stdout?.on('data', (chunk: Buffer) => onOutput(chunk, 'stdout'));
      child.stderr?.on('data', (chunk: Buffer) => onOutput(chunk, 'stderr'));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Jev service exited during startup (${code ?? 'signal'})`)));
    });
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Jev service startup timed out')), 15_000).unref()),
    ]);
    this.endpoint = await ModelSocketClient.connect(this.socketPath);
    const response = await this.endpoint.hello();
    if (!response.ok) throw new Error(`Jev hello failed: ${JSON.stringify(response.error)}`);
    const contract = response.result ?? {};
    this.log(`jev service ready model=${String(contract['model'] ?? 'unknown')} protocol=${this.endpoint.protocol}`);
    return { hello: contract };
  }

  async act(obs: PolicyObservation, seed: number): Promise<PolicyDecision> {
    if (this.stopped || !this.endpoint) throw new Error('Jev policy has not been started');
    if (this.held && obs.tS + 1e-9 < this.nextDecisionTS) {
      // Latch the vetted maneuver, not its first waypoint: the engine still
      // needs a future preview after advancing between Jev decisions.
      return { ...this.held, action: actionFromPlan(this.heldPlan, obs, this.heldAtTS), latencyMs: 0, extras: { ...this.held.extras, freshDecision: false, latched: true } };
    }
    const started = performance.now();
    const { scene, omittedOccludedObjects } = makeScene(obs);
    let response: DecisionResponse;
    let serviceError: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.endpoint.act({ scene, omitted_occluded_objects: omittedOccludedObjects, route: obs.route }, seed, undefined, { observation: obs, cameras: [] }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Jev service request timed out')), SERVICE_TIMEOUT_MS); }),
      ]);
      if (!result.ok) throw new Error(`Jev act failed: ${JSON.stringify(result.error)}`);
      response = result.result as DecisionResponse;
    } catch (error) {
      response = { error: error instanceof Error ? error.message : String(error), fallback_reason: 'service_error', feasible: [], rejected: {}, probabilities: {}, confidence: null, latched_maneuver: 'emergency_brake' };
      serviceError = response.error;
    } finally {
      clearTimeout(timer);
    }
    if (serviceError) {
      this.log(`jev decision service_error=${serviceError}`);
    } else if (response.api_call) {
      this.log(`jev api_call latency_ms=${String(response.api_latency_ms ?? 'null')} choice=${String(response.jev_choice ?? 'none')} fallback=${String(response.fallback_reason ?? 'none')}`);
    }
    this.heldPlan = serviceError ? [] : anchorPlan(response.points, obs);
    this.heldAtTS = obs.tS;
    const action = actionFromPlan(this.heldPlan, obs, this.heldAtTS);
    const trajectory = this.heldPlan.length > 0 ? this.heldPlan.map((point) => [point.x, point.y]) : null;
    const reasoning = fallbackReasoning(response, action);
    const latencyMs = performance.now() - started;
    const decision: PolicyDecision = {
      action,
      reasoning,
      trajectory,
      latencyMs,
      extras: {
        plan: response.plan,
        health: response.health,
        model: 'jev-1.13.0',
        decisionHz: this.replanHz,
        schemaVersion: response.schema_version ?? 'scene-observation/v2',
        sceneValidated: response.scene_validated ?? false,
        apiCall: response.api_call ?? false,
        apiCallCount: response.api_call_count ?? 0,
        apiLatencyMs: response.api_latency_ms ?? null,
        fallbackReason: response.fallback_reason ?? (serviceError ? 'service_error' : null),
        feasibleCandidates: response.feasible ?? [],
        rejectedCandidates: response.rejected ?? {},
        omittedOccludedObjects,
        freshDecision: true,
        ...(serviceError ? { serviceError } : {}),
      },
    };
    this.held = decision;
    this.nextDecisionTS = obs.tS + 1 / this.replanHz;
    return decision;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.endpoint?.close().catch(() => undefined);
    this.endpoint = undefined;
    this.held = undefined;
    this.heldPlan = [];
    const child = this.child;
    this.child = undefined;
    child?.stdout?.removeAllListeners('data');
    child?.stderr?.removeAllListeners('data');
    await stopProcess(child, 2_000);
    if (this.socketPath) await fs.rm(this.socketPath, { force: true });
    this.socketPath = undefined;
  }

}

