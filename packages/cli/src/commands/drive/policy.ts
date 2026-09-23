import type { LaneGraph } from '@simforge-oss/engine';
import type { EnvAction, ObservedSignal } from '@simforge-oss/training-env';
import type { ReasoningRecord } from '@simforge-oss/evaluation/drive-evidence';
import type { FollowLimits, PlanPoint } from './policies/trajectory.js';

/** Policy-facing adapter view of the kernel Episode snapshot (a ground-truth surface). */
export interface SessionActorSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly yawRad: number;
  readonly speedMps: number;
  readonly present: boolean;
}


export interface PolicyObservation {
  step: number; tS: number;
  pose: { x: number; y: number; yawRad: number; speedMps: number };
  egoHistory: number[][];                       // oldest→newest [x,y,yaw,speed,tS], ≥64 entries once warm
  frames: Record<string, Buffer[]>;             // sensorId → RGB history oldest→newest (width/height from profile)
  frameSize: { width: number; height: number };
  egoId: string;                                // the ego row's id within `actors`
  actors: readonly SessionActorSnapshot[];      // native snapshot of every actor, ego included
  route: { points: number[][]; remainingM: number }; // lane-graph route ahead of ego, world frame, ≥2 points
  nativeObservation?: { stateVector: readonly number[]; objects: readonly (readonly number[])[]; signals?: readonly ObservedSignal[] };
  mapId: string; graph: LaneGraph;              // whatever loadMap() returns today
}

/**
 * Free-form per-model telemetry recorded verbatim in `steps.jsonl`. The named
 * keys are the ones the runner, `verify`, and the showreel tooling read.
 */
export interface PolicyExtras extends Record<string, unknown> {
  /** Set when the policy applied its own safety fallback instead of the model's choice. */
  fallbackReason?: string | null;
  /** True when a decision is a held/latched copy of an earlier fresh one. */
  latched?: boolean;
}

export interface PolicyDecision {
  action: EnvAction;                             // policy setpoint/control; runner encodes the Episode action
  reasoning: ReasoningRecord;
  trajectory: number[][] | null;                 // world-frame [x,y] preview for HUD, optional
  latencyMs: number;
  extras?: PolicyExtras;
  /** Adapter follower state for matched-cadence holding; never re-anchor to the current pose. */
  tracking?: { points: readonly PlanPoint[]; limits: FollowLimits; issuedTS: number };
}

export interface Policy {
  readonly id: string;
  readonly cameraProfile: string;                // key into PROFILES; 'none' for image-free policies
  readonly historyFrames: number;                // frames per camera the policy wants
  readonly egoHistorySteps?: number;             // defaults to the shared 64-step visual-model prologue
  readonly obsPreset?: 'visible';                // select kernel LOS filtering before object-cap truncation
  /** A policy-owned inference schedule still receives every barrier to track held plans. */
  readonly replanHz?: number;
  start(ctx: { mapId: string; graph: LaneGraph; out: string; log: (line: string) => void }): Promise<{ hello: unknown }>;
  act(obs: PolicyObservation, seed: number): Promise<PolicyDecision>;
  stop(): Promise<void>;
}
