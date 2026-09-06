/**
 * `TraceEvaluation` — the reject filters every generated concrete passes through.
 *
 * From `docs/research/interactions-and-edge-cases.md` §Parameterization:
 *
 * | filter | rejects when |
 * |---|---|
 * | `trivially_safe` | `minTTC > 3 s` (tag as negative control instead of dropping) |
 * | `physically_unavoidable` | required decel exceeds `μg` — RSS-style |
 * | `never_fired` | any trigger never fired |
 * | `out_of_window` | the criticality peak falls inside the proportional edge guard |
 * | `collision` | opt-in; off by default because some archetypes want contact |
 *
 * A scenario tagged `negative-control` keeps its `trivially_safe` finding but
 * is *accepted* — the taxonomy deliberately includes curb-standing pedestrians
 * and phantom-brake bait whose whole point is that nothing happens.
 *
 * The evaluation itself runs in the native runtime
 * (`EngineRuntime.evaluateTrace`); these are the documents it reads and writes.
 */

import type { ArrivalSolution } from '../result.js';

export interface EvaluateFilters {
  /** `minTTC` above this is trivially safe. Default 3 s. */
  readonly trivialTtcS?: number;
  /** PET above this is a trivially separated crossing. Default 1.5 s. */
  readonly trivialPetS?: number;
  /** Road-friction decel ceiling, m/s². Default `0.8 × 9.81 = 7.85`. */
  readonly maxAchievableDecelMps2?: number;
  /** Criticality window. Defaults to the proportional, edge-safe clip window. */
  readonly window?: [number, number];
  /** Treat any collision as a rejection. Default `false`. */
  readonly rejectCollisions?: boolean;
  /** Skip `trivially_safe`; the scenario is a deliberate negative control. */
  readonly negativeControl?: boolean;
  /** Only apply the never-fired filter to these interaction ids. */
  readonly requiredTriggers?: readonly string[];
  /**
   * Generated background road users, excluded from the `physically_unavoidable`
   * scan.
   *
   * WHY. That filter takes a maximum of `requiredDecelMax` over EVERY actor and
   * rejects the whole clip when it exceeds the friction ceiling. Left alone, one
   * background car braking hard for another background car — an event with no
   * relation whatsoever to the authored conflict — rejects the scenario.
   * Measured on `c3-allway-stop`: 3 of 4 accepted cells flipped
   * `critical -> unavoidable` for exactly this reason before the exclusion.
   * `evaluateTrace` fills this in from `trace.header.ambientActorIds`, so the
   * default stays empty and authored-only evaluation is unchanged.
   */
  readonly ambientActorIds?: readonly string[];
}

export type RejectCode =
  | 'trivially_safe'
  | 'physically_unavoidable'
  | 'never_fired'
  | 'out_of_window'
  | 'collision'
  | 'occlusion_unproven'
  | 'no_interaction';

export interface RejectFinding {
  readonly code: RejectCode;
  readonly reason: string;
  readonly detail?: Record<string, unknown>;
}

export interface TraceEvaluation {
  readonly verdict: 'accept' | 'reject';
  readonly findings: RejectFinding[];
  readonly tags: string[];
  /** Convenience copy of the numbers the verdict was based on. */
  readonly summary: {
    readonly minTTC: number | null;
    readonly minTTCt: number | null;
    /** Mechanism-aware minimum selected from circle TTC and crossing path-TTC. */
    readonly criticalityKind: 'ttc' | 'path-ttc' | 'pet' | null;
    readonly criticality: number | null;
    readonly criticalityT: number | null;
    readonly requiredDecelMax: number;
    readonly collisions: number;
    readonly neverFired: number;
    readonly occlusionUnproven: number;
  };
}

export const DEFAULT_TRIVIAL_TTC_S = 3;
export const DEFAULT_TRIVIAL_PET_S = 1.5;
export const DEFAULT_MAX_DECEL_MPS2 = 0.8 * 9.81;


/** One tier-2 template invariant checked against a trace, in the invariant's own units. */
export interface InvariantResidualReport {
  readonly id: string;
  readonly kind: string;
  readonly essentiality: string;
  readonly status: 'held' | 'violated' | 'unchecked';
  readonly range: [number | null, number | null] | null;
  readonly achieved: number | null;
  /** Signed distance outside the range, in the invariant's own units. */
  readonly residual: number;
  readonly method: string;
  readonly reason: string;
}

/** Inputs of the native invariant checker beyond the template and trace. */
export interface InvariantCheckOptions {
  /** Expression scope for parameterised ranges (`params`, `clip`, `lane`). */
  readonly scope: Record<string, unknown>;
  readonly arrival: readonly ArrivalSolution[];
  readonly speedLimitKph: number | null;
}
