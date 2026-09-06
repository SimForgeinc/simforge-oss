/**
 * Documents the native engine returns from a whole-clip run.
 */

import type { SimIssue } from './errors.js';
import type { SimScenarioInput } from './schema/input.js';
import type { SimTrace } from './trace/trace.js';

/** Lightweight, renderer-independent map collision geometry. */
export type StaticColliderClass = 'building' | 'wall' | 'barrier' | 'prop' | 'road-boundary';

export interface StaticMapCollider {
  /** Stable within a map. The engine exposes contacts as `map:<id>`. */
  readonly id: string;
  readonly class: StaticColliderClass;
  /** Scene-frame OBB (`x/z`, y-up), matching scenario poses. */
  readonly obb: {
    readonly center: { readonly x: number; readonly z: number };
    readonly lengthM: number;
    readonly widthM: number;
    readonly headingRad: number;
  };
}

/** One spawn moved by the arrival solver so an `arrival` trigger fires at the authored delta. */
export interface ArrivalSolution {
  readonly interactionId: string | null;
  /** The actor whose spawn was moved. */
  readonly actorId: string;
  readonly referenceActorId: string;
  /** Signed change applied to the actor's spawn arc length, metres. */
  readonly spawnDeltaS: number;
  /** Resulting spawn arc length on the actor's route. */
  readonly spawnS: number;
  /** Requested `t_of − t_ref`, seconds. */
  readonly targetDeltaT: number;
  /** Achieved `t_of − t_ref`, seconds. */
  readonly achievedDeltaT: number;
  /** Achieved criticality in TTC form (`−achievedDeltaT`). */
  readonly achievedTtc: number;
  /** Time `of` reaches the point — the time an `arrival` trigger fires. */
  readonly fireTime: number;
  readonly iterations: number;
  readonly converged: boolean;
}

export interface SimResult {
  /**
   * Exact canonical input executed by the engine after deterministic
   * normalization and control/arrival resolution. `contentHash(input)` is the
   * identity recorded by `trace.header.inputHash`.
   */
  readonly input: SimScenarioInput;
  readonly trace: SimTrace;
  readonly issues: SimIssue[];
  readonly arrival: ArrivalSolution[];
}

/** Per-run engine switches; the lane graph is passed alongside. */
export interface RunOptions {
  /** Record the clip trace. Default `true` for whole-clip runs. */
  readonly captureTrace?: boolean;
  /** Move spawns so `arrival` triggers fire at their authored deltas. Default `true`. */
  readonly resolveArrival?: boolean;
  /** Also record the warm-up prologue (negative `t`). Default `false`. */
  readonly includeWarmupTrace?: boolean;
  /** Ambient road users follow their authored choreography (`scripted`) or react to the scene (`reactive`). */
  readonly ambientReactivity?: 'scripted' | 'reactive';
}
