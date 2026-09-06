/**
 * The causal ground-truth channel — the faithfulness-supervision contract.
 *
 * Per decision tick, the session records *why* the world changed in ways a
 * camera cannot show:
 *
 * - **LOS / occlusion transitions** per observer per target: every edge where
 *   geometric line of sight flipped, computed with the engine's occluder
 *   layer (same primitives the perception pass uses);
 * - **trigger causality**: trigger fires and skips with the exact predicate
 *   that caused them (canonical-JSON summary of the authored condition), plus
 *   preemption/release/completion events verbatim from the engine;
 * - **conflict genesis**: the first decision at which a monitored pair's
 *   running minimum TTC or distance crosses its criticality threshold.
 *
 * The channel is versioned (`causalVersion: 1`) and serialized as an optional
 * trace-side channel following the `ambientActorIds` precedent: absent on any
 * trace that did not carry it, so historical digests are untouched. Round
 * trips are byte-exact through `canonicalJson`.
 *
 * Frames are recorded by the native session (`simforge-session::causal`) and
 * surfaced per decision in `StepInfo.causal`; `EnvSession.causalChannel()`
 * returns the accumulated channel.
 */

import { canonicalJson } from '@simforge-oss/engine';

export const CAUSAL_CHANNEL_VERSION = 1;

/** Default genesis thresholds; banded criticality comes with Phase 3 curriculum. */
export const CONFLICT_GENESIS_TTC_S = 3;
export const CONFLICT_GENESIS_DISTANCE_M = 5;

export interface CausalLosTransition {
  readonly observerId: string;
  readonly targetId: string;
  readonly becameVisible: boolean;
}

export interface CausalTriggerRecord {
  readonly tS: number;
  readonly kind: 'fired' | 'skipped' | 'preemption' | 'released' | 'completed';
  readonly interactionId: string;
  readonly actorId: string;
  /** Exact canonical-JSON summary of the authored predicate, for fired/skipped. */
  readonly condition?: string;
  readonly forced?: boolean;
  readonly reason?: string;
}

export interface CausalConflictGenesis {
  readonly a: string;
  readonly b: string;
  readonly metric: 'ttc' | 'distance';
  /** Threshold whose first crossing this record is. */
  readonly threshold: number;
  /** Running minimum value at the crossing decision. */
  readonly value: number;
}

export interface CausalFrame {
  readonly tS: number;
  readonly losTransitions: readonly CausalLosTransition[];
  readonly triggers: readonly CausalTriggerRecord[];
  readonly conflictGenesis: readonly CausalConflictGenesis[];
}

export interface CausalChannel {
  readonly causalVersion: typeof CAUSAL_CHANNEL_VERSION;
  readonly egoId: string;
  readonly decisionHz: number;
  readonly frames: readonly CausalFrame[];
}

/* --------------------------------------------------------- serialization */

export interface CausalTraceEnvelope {
  /** Versioned optional channel, present only when an episode recorded it — the ambientActorIds precedent. */
  readonly causal: CausalChannel;
}

/** Canonical bytes for persistence alongside (never inside) a historical trace. */
export function serializeCausalChannel(channel: CausalChannel): Uint8Array {
  return new TextEncoder().encode(canonicalJson(channel));
}

/** Byte-exact round trip of {@link serializeCausalChannel}. */
export function parseCausalChannel(bytes: Uint8Array): CausalChannel {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CausalChannel;
  if (parsed.causalVersion !== CAUSAL_CHANNEL_VERSION) {
    throw new Error(`unsupported causal channel version: ${String(parsed.causalVersion)}`);
  }
  return parsed;
}
