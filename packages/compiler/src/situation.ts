/**
 * Situation programs: compile, rehearse, solve and compare — all native.
 *
 * A situation program is lowered through the same map-bound/portable compiler
 * as a template (never a second physics model), proved against its authority
 * declarations, and rehearsed by actually running the engine and sampling each
 * observation predicate with the engine's own geometry/perception at the exact
 * trace timestamp. Solving is a bounded deterministic coordinate search where
 * every candidate is simulated; comparing reruns base and intervention under
 * the identical seed, sensor recipe and timing.
 *
 * This module carries the option/result documents and forwards each call to
 * the native compiler (`simforge-compiler::situation`) through the module
 * bound by `@simforge-oss/engine/node`.
 */

import type { CatalogEntry } from '@simforge-oss/asset-catalog/metadata';
import type { AmbientTrafficProfile, Condition as RuntimeCondition, NativePolicyHook, RunOptions, ScenarioInput, SimResult } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';
import { guard, type EnvAction } from '@simforge-oss/native-runtime/shared';
import type { SituationProgram, SituationTransaction } from '@simforge-oss/scenario';

import type { MatchedSite } from './anchor/index.js';
import type { CatalogVariantApplication, MaterializeResult } from './materialize.js';
import type { MapBundle } from './types.js';

export interface GeneratedStaticGeometryDescriptor {
  readonly schema: 'simforge.generated-static-geometry/v1';
  readonly jobId: string;
  readonly mapId: string;
  readonly sourceArtifacts: readonly { readonly id: string; readonly uri: string; readonly sha256: string }[];
  readonly objectIds: readonly string[];
  readonly asset: { readonly id: string; readonly uri: string; readonly sha256: string; readonly kind: 'mesh'; readonly format: 'glb'; readonly frame: 'simforge-y-up' };
  readonly placement: { readonly position: readonly [number, number, number]; readonly headingRad: 0; readonly groundOffsetM: number };
  readonly dimensions: { readonly l: number; readonly w: number; readonly h: number };
  readonly support: { readonly motion: 'static'; readonly collision: 'planar-opaque-obb'; readonly occlusion: 'planar-opaque-obb' };
}

/** Trust boundary: the Node loader verifies all artifact bytes before supplying
 * this value. The compiler checks that precisely these effects are consumed by
 * canonical static actors; it does not perform filesystem I/O or triangle physics. */
export interface VerifiedStaticGeometryBinding {
  readonly patchId: string;
  readonly patchSha256: string;
  readonly roleId: string;
  readonly descriptor: GeneratedStaticGeometryDescriptor;
  readonly catalogEntry: CatalogEntry;
}

/** Materialization knobs a situation compile accepts; `seed` is required. */
export interface SituationMaterializeOptions {
  readonly seed: string;
  readonly drawIndex?: number;
  readonly variant?: CatalogVariantApplication;
  readonly ambient?: AmbientTrafficProfile;
  readonly ambientSettleSeconds?: number;
}

export interface SituationCompileOptions {
  readonly materialize: SituationMaterializeOptions;
  /** Portable programs: the matcher site to ground on (`MatchedSite` or its id); absent = top-ranked site. Map-bound programs skip matching. */
  readonly site?: MatchedSite | string;
  readonly geometryBindings?: readonly VerifiedStaticGeometryBinding[];
}

export type AuthorityKind = 'recorded' | 'controller' | 'policy';

export interface BoundSituation {
  readonly programDigest: string;
  readonly execution: MaterializeResult;
  readonly observations: readonly { readonly id: string; readonly condition: RuntimeCondition }[];
  readonly authority: readonly {
    readonly roleId: string;
    readonly kind: AuthorityKind;
    readonly startS: number;
    readonly endS: number;
    readonly intervalIndex: number;
    readonly handoverInteractionId?: string;
    readonly routeKind: string;
    readonly actionHookAvailable: boolean;
  }[];
  readonly visualOnlyPatches: readonly string[];
}

/** A compiled situation with the validated native scenario handle beside its evidence. */
export interface CompiledSituation extends BoundSituation {
  readonly scenario: ScenarioInput;
}

export interface SituationEventWitness {
  readonly id: string;
  readonly firstTrueS: number | null;
  readonly lastTrueS: number | null;
  readonly trueTicks: number;
  readonly sampledTicks: number;
  readonly windowS: readonly [number, number];
  readonly transitions: readonly { readonly timeS: number; readonly value: boolean }[];
}
export interface SituationConstraintWitness {
  readonly id: string;
  readonly satisfied: boolean;
  readonly residualS: number | null;
  readonly reason: 'satisfied' | 'event_missing' | 'offset_outside_bounds';
}
export interface SituationRehearsal {
  readonly bound: BoundSituation;
  readonly simulation: SimResult;
  readonly events: readonly SituationEventWitness[];
  readonly constraints: readonly SituationConstraintWitness[];
  readonly satisfied: boolean;
  readonly actionCalls: Readonly<Record<string, number>>;
  readonly authorityIntervals: readonly {
    readonly roleId: string;
    readonly intervalIndex: number;
    readonly startS: number;
    readonly endS: number;
    readonly hookCalls: number;
    readonly actionCalls: number;
  }[];
  readonly authorityTransitions: readonly {
    readonly roleId: string;
    readonly timeS: number;
    readonly from: AuthorityKind;
    readonly to: AuthorityKind;
    readonly handoverInteractionId?: string;
    readonly state: { readonly x: number; readonly y: number; readonly headingRad: number; readonly speedMps: number };
  }[];
}
/** Supplies the action for a declared policy role at one decision tick; `null` is a rehearsal failure, never a silent controller fallback. */
export type SituationPolicyHook = (context: {
  readonly tS: number;
  readonly dtS: number;
  readonly actorId: string;
  readonly actor: { readonly x: number; readonly y: number; readonly headingRad: number; readonly speedMps: number };
}) => EnvAction | null;

export interface SituationRehearsalOptions extends SituationCompileOptions {
  readonly runtime?: RunOptions;
  /** Actions for roles declared under `policy` authority. */
  readonly policy?: SituationPolicyHook;
}

export interface SituationSolveOptions extends SituationRehearsalOptions {
  /** Integer in `[1, 256]`. */
  readonly maxEvaluations: number;
  /** Fraction of each knob's range at which the coordinate search stops; `(0, 1]`. */
  readonly relativeResolution?: number;
  /** Persist exact successful executions without retaining every trace in memory.
   * Callback failures abort solving rather than becoming scenario failures. */
  readonly onEvaluation?: (program: SituationProgram, rehearsal: SituationRehearsal) => void;
}
export interface SituationSolveResult {
  readonly status: 'satisfied' | 'budget_exhausted' | 'resolution_reached' | 'no_knobs';
  readonly program: SituationProgram;
  readonly transaction: SituationTransaction | null;
  readonly rehearsal: SituationRehearsal;
  readonly attempts: readonly { readonly values: readonly number[]; readonly inputHash: string | null; readonly score: number | null; readonly error: string | null }[];
}

export interface SituationComparison {
  readonly base: SituationRehearsal;
  readonly intervention: SituationRehearsal;
  readonly changedRoles: readonly string[];
  readonly changedTracks: readonly string[];
  readonly invariantFailures: readonly string[];
  readonly eventDeltas: readonly { readonly id: string; readonly deltaS: number | null; readonly baseOccurs: boolean; readonly interventionOccurs: boolean }[];
}

interface NativeSituationOptions {
  readonly materialize: SituationMaterializeOptions;
  readonly siteId?: string;
  readonly geometryBindings?: readonly VerifiedStaticGeometryBinding[];
  readonly runtime?: RunOptions;
  readonly maxEvaluations?: number;
  readonly relativeResolution?: number;
  readonly reactiveRoleIds?: readonly string[];
}

/** Options as the native compiler reads them: the matched site collapses to its id, callbacks travel separately. */
function nativeOptions(
  options: SituationCompileOptions & Partial<Pick<SituationRehearsalOptions, 'runtime'>> & Partial<Pick<NativeSituationOptions, 'maxEvaluations' | 'relativeResolution' | 'reactiveRoleIds'>>,
): string {
  const { site, geometryBindings, materialize, runtime, maxEvaluations, relativeResolution, reactiveRoleIds } = options;
  const out: NativeSituationOptions = {
    materialize,
    ...(site === undefined ? {} : { siteId: typeof site === 'string' ? site : site.siteId }),
    ...(geometryBindings ? { geometryBindings } : {}),
    ...(runtime ? { runtime } : {}),
    ...(maxEvaluations === undefined ? {} : { maxEvaluations }),
    ...(relativeResolution === undefined ? {} : { relativeResolution }),
    ...(reactiveRoleIds ? { reactiveRoleIds } : {}),
  };
  return JSON.stringify(out);
}

function nativePolicy(policy: SituationPolicyHook | undefined): NativePolicyHook | null {
  if (!policy) return null;
  return (contextJson) => {
    const action = policy(JSON.parse(contextJson) as Parameters<SituationPolicyHook>[0]);
    return action === null ? null : JSON.stringify(action);
  };
}

/** Lower through the native map-bound/portable compiler, never a second physics model. */
export function compileSituation(program: SituationProgram, bundle: MapBundle, options: SituationCompileOptions): CompiledSituation {
  const [scenario, boundJson] = guard(() => engine().module.compileSituation(JSON.stringify(program), bundle.native, nativeOptions(options)));
  const bound = JSON.parse(boundJson) as BoundSituation;
  return { ...bound, scenario };
}

/** Predicate samples use the engine's own geometry/perception at the exact trace timestamp. */
export function rehearseSituation(program: SituationProgram, bundle: MapBundle, options: SituationRehearsalOptions): SituationRehearsal {
  const policy = nativePolicy(options.policy);
  return JSON.parse(guard(() => engine().module.rehearseSituation(JSON.stringify(program), bundle.native, nativeOptions(options), policy))) as SituationRehearsal;
}

interface SolveEvaluation {
  readonly program: SituationProgram;
  readonly rehearsal: SituationRehearsal;
}

/** Bounded deterministic coordinate search. Every candidate is actually simulated;
 * a failed budget is not a proof that the requested situation is impossible. */
export function solveSituation(program: SituationProgram, bundle: MapBundle, options: SituationSolveOptions): SituationSolveResult {
  const { onEvaluation, policy } = options;
  const callback = onEvaluation
    ? (evaluationJson: string) => {
        const evaluation = JSON.parse(evaluationJson) as SolveEvaluation;
        onEvaluation(evaluation.program, evaluation.rehearsal);
      }
    : null;
  return JSON.parse(guard(() => engine().module.solveSituation(JSON.stringify(program), bundle.native, nativeOptions(options), callback, nativePolicy(policy)))) as SituationSolveResult;
}

/** Compare a declared intervention under identical seed, sensor recipe and timing.
 * Reactive consequences must be named; unchanged actor inputs alone are not proof
 * that their resulting trajectories stayed fixed. */
export function compareSituation(
  program: SituationProgram,
  transaction: SituationTransaction,
  bundle: MapBundle,
  options: SituationRehearsalOptions & { readonly reactiveRoleIds: readonly string[] },
): SituationComparison {
  const policy = nativePolicy(options.policy);
  return JSON.parse(guard(() => engine().module.compareSituation(
    JSON.stringify(program),
    JSON.stringify(transaction),
    bundle.native,
    nativeOptions(options),
    policy,
  ))) as SituationComparison;
}


/** The executed input of a rehearsal, re-validated as a native scenario for further runs. */
export function rehearsalScenario(rehearsal: SituationRehearsal): ScenarioInput {
  return engine().scenario(rehearsal.simulation.input);
}
