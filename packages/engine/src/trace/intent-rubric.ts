/**
 * Deterministic, trace-evidence evaluation of a scenario's authored intent.
 *
 * This deliberately complements (and does not replace) the generic criticality
 * evaluator.  A compliant yield or stationary episode can be a successful
 * scenario even though it has no finite TTC.  Criteria are closed and typed:
 * anything outside this vocabulary is reported as unsupported rather than
 * inferred from prose.
 *
 * The evaluation and the blind-review packet are produced by the native
 * runtime (`EngineRuntime.evaluateIntentRubric` / `blindReviewPacket`); this
 * module is the rubric vocabulary and result documents.
 */

import { z } from 'zod';

import type { SimEvent } from './trace.js';

const windowSchema = z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()])
  .refine(([a, b]) => a <= b, 'window start must be <= end');
const refSchema = z.string().min(1).max(128);
const pairSchema = z.tuple([refSchema, refSchema]);
const requiredSchema = z.boolean().default(true);

const criterionSchemas = [
  z.object({ id: refSchema, kind: z.literal('event_order'), required: requiredSchema, mode: z.enum(['required', 'forbidden']).default('required'), interactionIds: z.array(refSchema).min(1).max(64) }),
  z.object({ id: refSchema, kind: z.literal('trigger'), required: requiredSchema, interactionId: refSchema, outcome: z.enum(['fired', 'skipped']) }),
  z.object({ id: refSchema, kind: z.literal('speed_band'), required: requiredSchema, actorId: refSchema, window: windowSchema.optional(), minMps: z.number().finite().nonnegative().optional(), maxMps: z.number().finite().nonnegative().optional() }),
  z.object({ id: refSchema, kind: z.literal('stationary_success'), required: requiredSchema, actorId: refSchema, window: windowSchema.optional(), maxSpeedMps: z.number().finite().nonnegative().default(0.1), minPresentSeconds: z.number().finite().nonnegative().optional() }),
  z.object({ id: refSchema, kind: z.literal('stop_hold_resume'), required: requiredSchema, actorId: refSchema, window: windowSchema.optional(), stopSpeedMps: z.number().finite().nonnegative().default(0.1), minHoldSeconds: z.number().finite().nonnegative(), mustResume: z.boolean().default(true), resumeMinSpeedMps: z.number().finite().positive().default(0.5), resumeByS: z.number().finite().nonnegative().optional() }),
  z.object({ id: refSchema, kind: z.literal('clearance'), required: requiredSchema, pair: pairSchema, window: windowSchema.optional(), measure: z.enum(['metric_gap', 'centre_distance']).default('metric_gap'), minM: z.number().finite().nonnegative() }),
  z.object({ id: refSchema, kind: z.literal('criticality'), required: requiredSchema, metric: z.enum(['ttc', 'path_ttc', 'pet']), pair: pairSchema.optional(), window: windowSchema.optional(), minS: z.number().finite().nonnegative().optional(), maxS: z.number().finite().nonnegative().optional() }),
  z.object({ id: refSchema, kind: z.literal('occlusion'), required: requiredSchema, observer: refSchema, target: refSchema, occluderId: refSchema.optional(), outcome: z.enum(['blocked_then_revealed', 'blocked_at_conflict', 'never_blocked']) }),
  z.object({ id: refSchema, kind: z.literal('lane_occupancy'), required: requiredSchema, actorId: refSchema, laneRsl: refSchema, mode: z.enum(['required', 'forbidden']).default('required'), window: windowSchema.optional() }),
  z.object({ id: refSchema, kind: z.literal('zone_occupancy'), required: requiredSchema, actorId: refSchema, mode: z.enum(['required', 'forbidden']).default('required'), window: windowSchema.optional(), zone: z.discriminatedUnion('shape', [z.object({ shape: z.literal('circle'), x: z.number().finite(), y: z.number().finite(), radiusM: z.number().finite().positive() }), z.object({ shape: z.literal('box'), minX: z.number().finite(), maxX: z.number().finite(), minY: z.number().finite(), maxY: z.number().finite() }).refine((v) => v.minX <= v.maxX && v.minY <= v.maxY, 'invalid box bounds')]) }),
  z.object({ id: refSchema, kind: z.literal('collision'), required: requiredSchema, pair: pairSchema.optional(), maxCount: z.number().int().nonnegative().default(0) }),
  z.object({ id: refSchema, kind: z.literal('control_indication'), required: requiredSchema, signalId: refSchema, window: windowSchema.optional(), mode: z.enum(['required', 'forbidden']).default('required'), indications: z.array(z.string().min(1).max(32)).min(1).max(32) }),
  z.object({ id: refSchema, kind: z.literal('unsupported'), required: requiredSchema, description: z.string().min(1).max(1_000), reason: z.string().min(1).max(1_000) }),
] as const;

export const intentCriterionSchema = z.discriminatedUnion('kind', criterionSchemas);
export const intentRubricSchema = z.object({
  version: z.literal(1),
  intentId: z.string().min(1),
  title: z.string().min(1),
  originalIntent: z.string().min(1).max(8_000).optional(),
  criteria: z.array(intentCriterionSchema).min(1).max(256),
}).superRefine((rubric, ctx) => {
  const seen = new Set<string>();
  rubric.criteria.forEach((criterion, index) => {
    if (seen.has(criterion.id)) ctx.addIssue({ code: 'custom', path: ['criteria', index, 'id'], message: 'criterion id must be unique' });
    seen.add(criterion.id);
  });
});

export type IntentCriterion = z.infer<typeof intentCriterionSchema>;
export type IntentRubric = z.infer<typeof intentRubricSchema>;
export type IntentCriterionInput = z.input<typeof intentCriterionSchema>;
export type IntentRubricInput = z.input<typeof intentRubricSchema>;
export type CriterionStatus = 'pass' | 'fail' | 'unchecked' | 'unsupported';

export interface TraceEvidence {
  readonly source: 'trace_event' | 'actor_track' | 'metric' | 'signal_track' | 'rubric';
  readonly summary: string;
  readonly values: Readonly<Record<string, string | number | boolean | null | readonly string[] | readonly number[]>>;
}

export interface CriterionVerdict {
  readonly id: string;
  readonly kind: IntentCriterion['kind'];
  readonly required: boolean;
  readonly status: CriterionStatus;
  readonly reason: string;
  readonly evidence: readonly TraceEvidence[];
}

export interface BehaviorSummary {
  readonly version: 1;
  readonly trace: { readonly inputHash: string; readonly mapId: string; readonly clipSeconds: number; readonly dt: number; readonly actorCount: number };
  readonly actors: ReadonlyArray<{ readonly actorId: string; readonly presentFromS: number | null; readonly presentToS: number | null; readonly minSpeedMps: number | null; readonly maxSpeedMps: number | null; readonly finalSpeedMps: number | null; readonly distanceTravelledM: number; readonly stationaryIntervals: ReadonlyArray<readonly [number, number]>; readonly lanes: readonly string[] }>;
  readonly events: ReadonlyArray<{ readonly t: number; readonly kind: SimEvent['kind']; readonly actorId?: string; readonly interactionId?: string; readonly detail?: string }>;
  readonly metrics: { readonly collisions: number; readonly minTTC: number | null; readonly minPathTTC: number | null; readonly minPET: number | null; readonly triggerNeverFired: readonly string[]; readonly declaredOcclusion: ReadonlyArray<{ readonly observer: string; readonly target: string; readonly status: string; readonly firstBlockedT: number | null; readonly losOpenT: number | null }> };
  readonly truncated: { readonly actors: boolean; readonly events: boolean; readonly occlusions: boolean };
}

export interface IntentEvaluation {
  readonly version: 1;
  readonly intentId: string;
  readonly verdict: 'accept' | 'reject';
  readonly counts: Readonly<Record<CriterionStatus, number>>;
  readonly criteria: readonly CriterionVerdict[];
  readonly behaviorSummary: BehaviorSummary;
}

export interface BlindReviewPacket {
  readonly version: 1;
  readonly intentId: string;
  readonly title: string;
  readonly originalIntent: string | null;
  readonly rubric: IntentRubric;
  readonly behaviorSummary: BehaviorSummary;
  readonly machineEvaluation: Omit<IntentEvaluation, 'behaviorSummary'>;
}
