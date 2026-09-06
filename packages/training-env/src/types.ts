/**
 * Environment-level contracts for the SimForge RL core.
 *
 * Everything here is deterministic: no wall clock, no `Math.random`, no
 * iteration-order dependence. A policy that replays the same action sequence
 * against the same seed observes byte-identical episodes. Episodes execute in
 * the native runtime (`simforge-session`); these are the documents that cross
 * its boundary (`EpisodeConfig` in, `StepResult` out).
 */

import type { SimEvent } from '@simforge-oss/engine';
import type { EnvAction, PerceivedObject } from '@simforge-oss/native-runtime/shared';

import type { CausalFrame } from './causal.js';

export type { EnvAction, PerceivedObject };

/** Reward weights. One config object so training can retune without touching semantics. */
export interface RewardConfig {
  /** Applied once when a collision involving the ego terminates the episode. */
  collisionPenalty: number;
  /** Applied once when the configured goal (trigger fire or route end) is met. */
  goalBonus: number;
  /** Per metre of ego route progress within one decision interval. */
  progressWeight: number;
  /** Per-decision penalty weight on standing too close to any other actor. */
  proximityWeight: number;
  /** Actors closer than this contribute the proximity penalty. */
  proximityRangeM: number;
  /** Per-decision penalty weight on absolute longitudinal acceleration. */
  comfortAccelWeight: number;
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  collisionPenalty: -10,
  goalBonus: 10,
  progressWeight: 0.05,
  proximityWeight: 0.02,
  proximityRangeM: 15,
  comfortAccelWeight: 0.005,
};

/** Ego-centric BEV raster geometry. */
export interface BevConfig {
  /** Metres per cell edge. */
  resolutionM: number;
  /** Forward extent from the ego reference point, metres. */
  forwardM: number;
  /** Backward extent behind the ego, metres. */
  backwardM: number;
  /** Half-width of the raster either side of the ego, metres. */
  halfWidthM: number;
  /** Half-width used when stamping lane surface polygons. */
  laneHalfWidthM: number;
}

/** Raster channels: `[occupancy, lane surface, ego]`, as the native rasteriser stamps them. */
export const BEV_CHANNELS = 3;

export const DEFAULT_BEV_CONFIG: BevConfig = {
  resolutionM: 0.25,
  forwardM: 40,
  backwardM: 10,
  halfWidthM: 20,
  laneHalfWidthM: 1.75,
};

/** Observation-channel switches. */
export interface ObservationConfig {
  stateVector: boolean;
  /** Object-list gating range when an actor declares no sensors. */
  objectListRangeM: number;
  bev: Partial<BevConfig> | null;
}
export const DEFAULT_OBSERVATION_CONFIG: ObservationConfig = {
  stateVector: true,
  objectListRangeM: 60,
  bev: null,
};

/**
 * Episode timing and termination policy.
 *
 * `decisionHz` must divide the engine's 50 Hz tick evenly so decision
 * boundaries land exactly on integer ticks — time is derived from integer
 * tick indices, never accumulated.
 */
export interface EpisodeConfig {
  decisionHz: number;
  /** Overrides the input's authored clip length. */
  clipSeconds?: number;
  /** Warm-up ticks are consumed inside `reset` and never policy-visible. Default true. */
  warmupExcluded?: boolean;
  /** Truncate after this many decisions even if clip time remains. */
  maxDecisions?: number;
  /**
   * Goal definition for the completion bonus / `terminated` flag: a trigger
   * with this interaction id firing, and/or the ego running out of route.
   */
  goal?: { interactionId?: string; routeEnd?: boolean };
  reward?: Partial<RewardConfig>;
  observation?: Partial<ObservationConfig>;
}

/** Ego-centric BEV raster: row-major `[row][col]`, channel-last within each cell. Row 0 is farthest forward. */
export interface BevRaster {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: Float32Array;
}

/** Version 1 observation bundle. Every field is optional by config, never by surprise. */
export interface Observation {
  readonly tS: number;
  readonly stateVector: Float64Array | null;
  /** Perception-gated object entries, sorted by range then id. */
  readonly objects: readonly PerceivedObject[];
  readonly bev: BevRaster | null;
}

/** Running episode minima for one monitored pair, as of the decision. */
export interface PairMinima {
  readonly a: string;
  readonly b: string;
  readonly minDistanceM: number;
  readonly minTtcS: number | null;
  readonly minPathTtcS: number | null;
  readonly minPetS: number | null;
}

/** `[progress, proximity, comfort]` contributions of one decision. */
export interface RewardTerms {
  readonly progress: number;
  readonly proximity: number;
  readonly comfort: number;
}

/** Per-decision facts beside the observation. */
export interface StepInfo {
  readonly tS: number;
  /** Engine events recorded during this decision interval, in record order. */
  readonly events: readonly SimEvent[];
  readonly minima: readonly PairMinima[];
  /** This decision's causal frame; all frames accumulate into the channel. */
  readonly causal: CausalFrame;
  readonly rewardTerms: RewardTerms;
}

export interface StepResult {
  readonly observation: Observation;
  readonly reward: number;
  readonly terminated: boolean;
  readonly truncated: boolean;
  readonly info: StepInfo;
}
