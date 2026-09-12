/**
 * Host-neutral pieces shared by the Node and browser entries: the flat action
 * row layout, typed error classes and the small JSON decoders for per-call
 * metadata (`infoJson`, world outcomes). No engine semantics live here.
 */

/** Fixed engine rate; decisions are integer multiples of `1 / ENGINE_HZ`. */
export const ENGINE_HZ = 50;
export const STATE_VECTOR_SIZE = 10;
/** `[range_m, bearing_rad, range_rate_mps, los, valid]` per object row. */
export const OBJECT_FEATURES = 5;
export const ACTION_WIDTH = 9;
export const DEFAULT_MAX_OBJECTS = 64;
/** `[x, y, headingRad, speedMps, accelMps2, lateralOffsetM, lateralRateMps, s]` per actor row of `Simulation.actors()`. */
export const ACTOR_ROW = 8;
/** `[x, z, headingRad, speedMps, lengthM, widthM, present, static]` per actor row of `TrafficHandoff.step()` (scene ground plane). */
export const HANDOFF_ACTOR_ROW = 8;
/** `[origin, x, z, headingRad, speedMps, angularVelocityRadS]` per body row of `TrafficHandoff.bodies()`; `origin` 0 = traffic, 1 = authored. */
export const HANDOFF_BODY_ROW = 6;
/** BEV raster channels: drivable lane surface, ego lane surface, other-actor OBB occupancy. */
export const BEV_CHANNELS = 3;
/**
 * Binding ABI this package is typed against. Loaders compare it to the
 * module's `abiVersion()` and refuse any other value; bumped together with
 * `simforge_bindings_common::ABI_VERSION`.
 */
export const ABI_VERSION = 2;

/** Flat action slots. `NaN` leaves a field to the authored choreography. */
export const ACTION_SLOT = {
  targetSpeedMps: 0,
  targetAccelerationMps2: 1,
  motionDirection: 2,
  throttle: 3,
  brake: 4,
  steer: 5,
  previewX: 6,
  previewY: 7,
  previewHeadingRad: 8,
} as const;

/** One policy decision for the metric-subject actor (all fields optional). */
export interface EnvAction {
  readonly targetSpeedMps?: number;
  readonly targetAccelerationMps2?: number;
  readonly motionDirection?: -1 | 1;
  readonly previewPoint?: { readonly x: number; readonly y: number };
  readonly previewHeadingRad?: number;
  readonly control?: { readonly throttle: number; readonly brake: number; readonly steer: number };
}

/** Write `action` into `row`; unspecified control fields become `NaN`, while motion defaults to forward. */
export function encodeAction(action: EnvAction | null | undefined, row: Float64Array): Float64Array {
  if (row.length !== ACTION_WIDTH) throw new RangeError(`action row must have ${ACTION_WIDTH} slots, got ${row.length}`);
  row.fill(Number.NaN);
  if (!action) return row;
  row[ACTION_SLOT.motionDirection] = action.motionDirection ?? 1;
  if (action.targetSpeedMps !== undefined) row[ACTION_SLOT.targetSpeedMps] = action.targetSpeedMps;
  if (action.targetAccelerationMps2 !== undefined) row[ACTION_SLOT.targetAccelerationMps2] = action.targetAccelerationMps2;
  if (action.motionDirection !== undefined) row[ACTION_SLOT.motionDirection] = action.motionDirection;
  if (action.control) {
    row[ACTION_SLOT.throttle] = action.control.throttle;
    row[ACTION_SLOT.brake] = action.control.brake;
    row[ACTION_SLOT.steer] = action.control.steer;
  }
  if (action.previewPoint) {
    row[ACTION_SLOT.previewX] = action.previewPoint.x;
    row[ACTION_SLOT.previewY] = action.previewPoint.y;
  }
  if (action.previewHeadingRad !== undefined) row[ACTION_SLOT.previewHeadingRad] = action.previewHeadingRad;
  return row;
}

/** Encode `actions[i]` into row `i` of an `(N, ACTION_WIDTH)` matrix. */
export function encodeActionBatch(actions: readonly (EnvAction | null | undefined)[], out?: Float64Array): Float64Array {
  const matrix = out ?? new Float64Array(actions.length * ACTION_WIDTH);
  if (matrix.length !== actions.length * ACTION_WIDTH) {
    throw new RangeError(`action matrix must have ${actions.length * ACTION_WIDTH} values, got ${matrix.length}`);
  }
  for (let i = 0; i < actions.length; i += 1) {
    encodeAction(actions[i], matrix.subarray(i * ACTION_WIDTH, (i + 1) * ACTION_WIDTH));
  }
  return matrix;
}

export type NativeErrorKind = 'argument' | 'schema' | 'engine' | 'session' | 'unsupported' | 'runtime';

/** Every runtime failure. `kind` selects the family; `issues` carries structured schema/engine issues. */
export class NativeRuntimeError extends Error {
  readonly kind: NativeErrorKind;
  readonly issues: readonly Record<string, unknown>[] | null;

  constructor(kind: NativeErrorKind, message: string, issues: readonly Record<string, unknown>[] | null = null) {
    super(message);
    this.name = 'NativeRuntimeError';
    this.kind = kind;
    this.issues = issues;
  }
}

const KIND_NAMES: Record<NativeErrorKind, true> = { argument: true, schema: true, engine: true, session: true, unsupported: true, runtime: true };

function isKind(value: unknown): value is NativeErrorKind {
  return typeof value === 'string' && value in KIND_NAMES;
}

function parseIssues(issuesJson: unknown): Record<string, unknown>[] | null {
  if (typeof issuesJson !== 'string' || issuesJson.length === 0) return null;
  const parsed: unknown = JSON.parse(issuesJson);
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
}

/**
 * Rebuild a {@link NativeRuntimeError} from a raw binding error. The Node
 * binding packs `kind␟issuesJson␟message` into the reason; the WASM binding
 * sets `kind`/`issuesJson` properties directly.
 */
export function toNativeError(error: unknown): NativeRuntimeError {
  if (error instanceof NativeRuntimeError) return error;
  if (error instanceof Error) {
    const parts = error.message.split('\u001f');
    if (parts.length === 3 && isKind(parts[0])) {
      return new NativeRuntimeError(parts[0], parts[2]!, parseIssues(parts[1]));
    }
    if ('kind' in error && isKind(error.kind)) {
      return new NativeRuntimeError(error.kind, error.message, 'issuesJson' in error ? parseIssues(error.issuesJson) : null);
    }
    return new NativeRuntimeError('runtime', error.message);
  }
  return new NativeRuntimeError('runtime', String(error));
}

/** Run `fn`, converting binding errors to {@link NativeRuntimeError}. */
export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw toNativeError(error);
  }
}

/** Decoded `infoJson` of one decision. */
export interface StepInfo {
  readonly events: readonly Record<string, unknown>[];
  readonly minima: readonly {
    readonly a: string;
    readonly b: string;
    readonly minDistanceM: number;
    readonly minTtcS: number | null;
    readonly minPathTtcS: number | null;
    readonly minPetS: number | null;
  }[];
  readonly causal: Record<string, unknown>;
}

export function decodeStepInfo(infoJson: string): StepInfo {
  return JSON.parse(infoJson) as StepInfo;
}

/** Perceived-object rows of one decision as objects (hosts that prefer records over the flat slab). */
export interface PerceivedObject {
  readonly id: string;
  readonly rangeM: number;
  readonly bearingRad: number;
  readonly rangeRateMps: number;
  readonly lineOfSight: boolean;
}

export function decodeObjects(objects: Float32Array, objectIds: readonly string[]): PerceivedObject[] {
  const out: PerceivedObject[] = [];
  for (let i = 0; i < objectIds.length; i += 1) {
    const base = i * OBJECT_FEATURES;
    out.push({
      id: objectIds[i]!,
      rangeM: objects[base]!,
      bearingRad: objects[base + 1]!,
      rangeRateMps: objects[base + 2]!,
      lineOfSight: objects[base + 3]! > 0.5,
    });
  }
  return out;
}
