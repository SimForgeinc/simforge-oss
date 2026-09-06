/**
 * PolicySession — a deadline-accounted policy executor owning one native
 * `EnvSession`. Control actions pass through; trajectory actions are anchored
 * and tracked by the native pure-pursuit follower (or reduced to a speed
 * setpoint). Deadline misses resolve deterministically to the configured
 * fallback from the caller-reported `elapsedMs`.
 */

import type { LaneGraph, NativeModule, NativePolicySession, NativePolicyStepResult, ScenarioSource } from '@simforge-oss/engine';
import type { EngineRuntime } from '@simforge-oss/engine';
import { guard } from '@simforge-oss/native-runtime/shared';

import type { DeadlineReport, ExecutorFrame, FallbackPolicy, PolicyAction, TrajectoryExecution, TrajectoryPoint } from './policy-step.js';
import { decodeStepResult } from './session.js';
import { BEV_CHANNELS, type EpisodeConfig, type StepResult } from './types.js';

export interface PolicySessionOptions {
  readonly input: ScenarioSource;
  readonly graph: LaneGraph;
  readonly episode: EpisodeConfig;
  /** Per-decision inference budget; `undefined` = no deadline. */
  readonly deadlineMs?: number;
  /** Default `'repeat-last'`. */
  readonly fallback?: FallbackPolicy;
  /** Default `'pure-pursuit'`. */
  readonly execution?: TrajectoryExecution;
  readonly maxObjects?: number;
}

export interface PolicyStepResult {
  readonly step: StepResult;
  readonly deadline: DeadlineReport;
  /** Pure-pursuit telemetry when the follower ran this decision. */
  readonly executor: ExecutorFrame | null;
}

const TRAJECTORY_ROW = 5;

function encodeTrajectory(points: readonly TrajectoryPoint[]): Float64Array {
  const out = new Float64Array(points.length * TRAJECTORY_ROW);
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    const base = i * TRAJECTORY_ROW;
    out[base] = p.x;
    out[base + 1] = p.y;
    out[base + 2] = p.heading;
    out[base + 3] = p.speed;
    out[base + 4] = p.t;
  }
  return out;
}

export class PolicySession {
  readonly native: NativePolicySession;
  private bevShape: { height: number; width: number; channels: number } | null = null;

  constructor(module: NativeModule, engine: EngineRuntime, options: PolicySessionOptions) {
    const scenario = engine.scenario(options.input);
    this.native = guard(() => new module.PolicySession(
      scenario,
      options.graph,
      JSON.stringify(options.episode),
      options.deadlineMs ?? null,
      options.fallback ?? null,
      options.execution ?? null,
      options.maxObjects ?? null,
    ));
    const bev = options.episode.observation?.bev;
    if (bev) {
      const resolutionM = bev.resolutionM ?? 0.25;
      const forwardM = bev.forwardM ?? 40;
      const backwardM = bev.backwardM ?? 10;
      const halfWidthM = bev.halfWidthM ?? 20;
      this.bevShape = {
        height: Math.max(1, Math.round((forwardM + backwardM) / resolutionM)),
        width: Math.max(1, Math.round((2 * halfWidthM) / resolutionM)),
        channels: BEV_CHANNELS,
      };
    }
  }

  get ego(): string {
    return this.native.ego;
  }

  get execution(): TrajectoryExecution {
    return this.native.execution as TrajectoryExecution;
  }

  reset(seed?: number | string): StepResult {
    return decodeStepResult(guard(() => this.native.reset(seed ?? null)), this.bevShape);
  }

  /** Apply one policy action; `elapsedMs` is the caller-measured inference latency. */
  act(action: PolicyAction, elapsedMs?: number): PolicyStepResult {
    const outcome = action.kind === 'control'
      ? guard(() => this.native.actControl(action.throttle, action.brake, action.steer, elapsedMs ?? null))
      : guard(() => this.native.actTrajectory(encodeTrajectory(action.points), elapsedMs ?? null));
    return this.decode(outcome);
  }

  checkpoint(): Uint8Array {
    return guard(() => this.native.checkpoint());
  }

  egoPose(): { tS: number; x: number; y: number; yawRad: number; speedMps: number } {
    const [tS, x, y, yawRad, speedMps] = guard(() => this.native.egoPose());
    return { tS: tS!, x: x!, y: y!, yawRad: yawRad!, speedMps: speedMps! };
  }

  private decode(outcome: NativePolicyStepResult): PolicyStepResult {
    return {
      step: decodeStepResult(outcome.step, this.bevShape),
      deadline: {
        limitMs: outcome.deadlineLimitMs ?? null,
        elapsedMs: outcome.deadlineElapsedMs ?? null,
        miss: outcome.deadlineMiss,
        applied: outcome.applied as DeadlineReport['applied'],
      },
      executor: outcome.executorJson ? (JSON.parse(outcome.executorJson) as ExecutorFrame) : null,
    };
  }
}
