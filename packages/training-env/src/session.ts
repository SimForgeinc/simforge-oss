/**
 * EnvSession — Gymnasium-semantics `reset`/`step` over one native episode.
 *
 * Decisions land on integer engine ticks (`decisionHz` divides 50 Hz), warm-up
 * is consumed inside `reset` and never policy-visible, rewards and observations
 * are assembled by the native session. This façade decodes the owned typed
 * arrays and JSON metadata the binding returns into the documented
 * `StepResult`; the raw handle stays reachable as `native` for consumers that
 * want the flat slabs.
 */

import type { LaneGraph, NativeEnvSession, NativeModule, NativeSessionBatch, NativeStepResult, ScenarioSource, SignalSnapshot } from '@simforge-oss/engine';
import type { EngineRuntime } from '@simforge-oss/engine';
import {
  ACTION_WIDTH,
  decodeObjects,
  encodeAction,
  encodeActionBatch,
  guard,
  type EnvAction,
  type NativeErrorKind,
} from '@simforge-oss/native-runtime/shared';

import type { CausalChannel } from './causal.js';
import type { BevRaster, EpisodeConfig, Observation, PairMinima, RewardTerms, StepInfo, StepResult } from './types.js';

export type { NativeErrorKind };

export interface EnvSessionOptions {
  readonly input: ScenarioSource;
  readonly graph: LaneGraph;
  readonly episode: EpisodeConfig;
  /** Perceived-object slab rows (zero-padded). Default 64. */
  readonly maxObjects?: number;
}

/** Live signal state at one instant: every program's snapshot plus active overrides. */
export interface SignalBookState {
  readonly tS: number;
  readonly signals: readonly SignalSnapshot[];
  readonly overrides: Readonly<Record<string, string>>;
}

interface RawInfo {
  readonly events: StepInfo['events'];
  readonly minima: readonly PairMinima[];
  readonly causal: StepInfo['causal'];
}

/** Decode one native decision into the documented `StepResult`. */
export function decodeStepResult(raw: NativeStepResult, bevShape: { height: number; width: number; channels: number } | null | undefined): StepResult {
  const info = JSON.parse(raw.infoJson) as RawInfo;
  const bev: BevRaster | null = raw.bev && bevShape
    ? { width: bevShape.width, height: bevShape.height, channels: bevShape.channels, data: raw.bev }
    : null;
  const rewardTerms: RewardTerms = { progress: raw.rewardTerms[0]!, proximity: raw.rewardTerms[1]!, comfort: raw.rewardTerms[2]! };
  const observation: Observation = {
    tS: raw.tS,
    stateVector: raw.stateVector.length === 0 ? null : raw.stateVector,
    objects: decodeObjects(raw.objects, raw.objectIds),
    bev,
  };
  return {
    observation,
    reward: raw.reward,
    terminated: raw.terminated,
    truncated: raw.truncated,
    info: { tS: raw.tS, events: info.events, minima: info.minima, causal: info.causal, rewardTerms },
  };
}

export class EnvSession {
  readonly native: NativeEnvSession;
  private readonly row = new Float64Array(ACTION_WIDTH);

  constructor(module: NativeModule, engine: EngineRuntime, options: EnvSessionOptions) {
    const scenario = engine.scenario(options.input);
    this.native = guard(() => new module.EnvSession(scenario, options.graph, JSON.stringify(options.episode), options.maxObjects ?? null));
  }

  /** The metric-subject actor all actions apply to. */
  get ego(): string {
    return this.native.ego;
  }

  get decisionHz(): number {
    return this.native.decisionHz;
  }

  get clipSeconds(): number {
    return this.native.clipSeconds;
  }

  /**
   * Begin a new episode. `seed` overrides the input's authored seed; everything
   * else about the scenario is preserved byte-for-byte. Warm-up is consumed here.
   */
  reset(seed?: number | string): StepResult {
    return decodeStepResult(guard(() => this.native.reset(seed ?? null)), this.native.bevShape);
  }

  /**
   * Apply one decision and advance `50 / decisionHz` engine ticks. Fields left
   * `undefined` keep the authored choreography; an empty action is scripted.
   */
  step(action: EnvAction = {}): StepResult {
    encodeAction(action, this.row);
    return decodeStepResult(guard(() => this.native.step(this.row)), this.native.bevShape);
  }

  /** Opaque, portable continuation state of the current decision. */
  checkpoint(): Uint8Array {
    return guard(() => this.native.checkpoint());
  }

  /** Restore a checkpoint; returns the exact `StepResult` that decision produced. */
  restore(checkpoint: Uint8Array): StepResult {
    return decodeStepResult(guard(() => this.native.restore(checkpoint)), this.native.bevShape);
  }

  /** Ego pose at the current decision; throws before `reset()`. */
  egoPose(): { tS: number; x: number; y: number; yawRad: number; speedMps: number } {
    const [tS, x, y, yawRad, speedMps] = guard(() => this.native.egoPose());
    return { tS: tS!, x: x!, y: y!, yawRad: yawRad!, speedMps: speedMps! };
  }

  /** Live signal state (overrides included); throws before `reset()`. */
  signalBook(): SignalBookState {
    return JSON.parse(guard(() => this.native.signalBookJson())) as SignalBookState;
  }

  /** The accumulated causal ground-truth channel of the current episode. */
  causalChannel(): CausalChannel {
    return JSON.parse(guard(() => this.native.causalChannelJson())) as CausalChannel;
  }
}

/* --------------------------------------------------------------- batch */

export interface SessionBatchOptions {
  /** One scenario per world; `graphs` is parallel (one graph per world). */
  readonly inputs: readonly ScenarioSource[];
  readonly graphs: readonly LaneGraph[];
  readonly episode: EpisodeConfig;
  /** Worker threads for stepping; `0` = engine default. Ignored by the WASM host. */
  readonly threads?: number;
  readonly maxObjects?: number;
}

/**
 * N independent worlds stepped together; results come back as world-major
 * flat typed arrays (the shape a vectorised learner consumes). Per-world
 * metadata is available on demand.
 */
export class SessionBatch {
  readonly native: NativeSessionBatch;

  constructor(module: NativeModule, engine: EngineRuntime, options: SessionBatchOptions) {
    if (options.inputs.length !== options.graphs.length) {
      throw new RangeError(`inputs (${options.inputs.length}) and graphs (${options.graphs.length}) must be parallel`);
    }
    const scenarios = options.inputs.map((input) => engine.scenario(input));
    this.native = guard(() => new module.SessionBatch(scenarios, [...options.graphs], JSON.stringify(options.episode), options.threads ?? null, options.maxObjects ?? null));
  }

  get size(): number {
    return this.native.size;
  }

  get egos(): string[] {
    return this.native.egos;
  }

  resetAll(seeds?: readonly (number | string)[]) {
    return guard(() => this.native.resetAll(seeds ? [...seeds] : null));
  }

  /** Reset only `worlds`; `seeds[k]` (may be `null`) applies to `worlds[k]`. */
  resetWorlds(worlds: readonly number[], seeds?: readonly (number | string | null)[]) {
    return guard(() => this.native.resetWorlds([...worlds], seeds ? [...seeds] : null));
  }

  /** One action per world (or a pre-encoded `(N, ACTION_WIDTH)` matrix); `mask[i] === 0` skips world `i`. */
  stepBatch(actions: readonly (EnvAction | null | undefined)[] | Float64Array, mask?: Uint8Array) {
    const matrix = actions instanceof Float64Array ? actions : encodeActionBatch(actions);
    return guard(() => this.native.stepBatch(matrix, mask ?? null));
  }

  objectIds(world: number): string[] {
    return guard(() => this.native.objectIds(world));
  }

  info(world: number): RawInfo {
    return JSON.parse(guard(() => this.native.infoJson(world))) as RawInfo;
  }

  checkpoint(world: number): Uint8Array {
    return guard(() => this.native.checkpoint(world));
  }

  restore(world: number, checkpoint: Uint8Array): void {
    guard(() => this.native.restore(world, checkpoint));
  }
}
