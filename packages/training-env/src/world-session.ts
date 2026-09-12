/**
 * WorldSession — a multi-client, command-driven world (world-session v1).
 *
 * Clip sessions preserve the authored finite-trace behaviour and rebuild after
 * structural commands; live sessions mutate actors incrementally and never end.
 * In either mode the canonical input plus the ordered command log is the
 * deterministic replay artifact, and every engine tick with `tS >= 0` is
 * chained into the digest.
 *
 * The world itself runs in the native runtime (`simforge-session::world`);
 * this façade converts commands, snapshots and logs at the JSON/typed-array
 * boundary and hands out truth-stream subscriptions.
 */

import type { ActorKind, Dims, LaneGraph, NativeModule, NativeTruthSubscription, NativeWorldSession, RouteSpec, ScenarioSource, SimEvent } from '@simforge-oss/engine';
import type { EngineRuntime } from '@simforge-oss/engine';
import { guard, type EnvAction } from '@simforge-oss/native-runtime/shared';

import { TruthStreamClient, type TruthFrame, type TruthSubscriptionStats } from './truth-stream.js';

/** Version tag of the session-log artifact; bumped on any breaking change. */
export const WORLD_SESSION_LOG_VERSION = 2;

/* ------------------------------------------------------------- commands */

/**
 * A runtime spawn request. Everything beyond `kind` and `pose` has an
 * engine-derived default: dims from the actor catalog, lane placement from
 * the nearest drivable lane (road kinds), heading from the snapped lane
 * tangent, and a `follow` route from the snapped lane (road kinds) or a
 * zero-length `polyline` hold (everything else).
 */
export interface SpawnRequest {
  /** Explicit actor id; must be globally unused. Omitted = allocated (`ws:NNNN`). */
  readonly id?: string;
  readonly kind: ActorKind;
  /** Scene-frame ground pose. `headingRad` optional when lane-snapped. */
  readonly pose: { readonly x: number; readonly z: number; readonly headingRad?: number };
  readonly speedMps?: number;
  readonly dims?: Dims;
  /** Explicit route; overrides the snap-derived default. */
  readonly route?: RouteSpec;
  readonly cruiseSpeedMps?: number;
  /** Snap pose to the nearest drivable lane. Default: road actor kinds. */
  readonly snapToLane?: boolean;
  readonly static?: boolean;
  readonly tags?: readonly string[];
}

export type BatchOp =
  | { readonly kind: 'spawn'; readonly spawn: SpawnRequest }
  | { readonly kind: 'despawn'; readonly actorId: string };

/**
 * A live driver's pedals and wheel: exactly what a game client sends, and
 * what the `dynamic-v1` integrator applies at every substep while it is
 * held. Throttle and brake are `[0, 1]`, steer is `[-1, 1]` as a fraction of
 * the class's steering lock, and the handbrake is the rear-axle parking
 * brake — independent of the brake pedal.
 */
export interface DriverCommand {
  readonly throttle: number;
  readonly brake: number;
  readonly steer: number;
  readonly handbrake?: boolean;
}

export type WorldCommand =
  | { readonly kind: 'spawn'; readonly spawn: SpawnRequest }
  | { readonly kind: 'despawn'; readonly actorId: string }
  /** Atomic: every op applies, or none does and the world is untouched. */
  | { readonly kind: 'batch'; readonly ops: readonly BatchOp[] }
  /** Zero-order-hold action override for one actor; `null` releases it. */
  | { readonly kind: 'act'; readonly actorId: string; readonly action: EnvAction | null }
  /** Zero-order-hold driver command for one actor; `null` releases it. */
  | { readonly kind: 'driverCommand'; readonly actorId: string; readonly command: DriverCommand | null };

export interface CommandOutcome {
  readonly ok: boolean;
  /** Actor ids allocated/affected by spawn ops, in op order. */
  readonly actorIds?: readonly string[];
  readonly error?: string;
}

/* ------------------------------------------------------------ session log */

export type WorldLogEntry =
  | {
      readonly kind: 'command';
      readonly clientId: string;
      readonly seq: number;
      readonly command: WorldCommand;
      readonly ok: boolean;
      readonly actorIds?: readonly string[];
      readonly error?: string;
    }
  | { readonly kind: 'advance'; readonly ticks: number };

/** The session log artifact: everything needed to replay the world exactly. */
export interface WorldSessionLog {
  readonly version: typeof WORLD_SESSION_LOG_VERSION;
  /** `contentHash` of the normalized base input the session was built from. */
  readonly baseInputHash: string;
  readonly mode: 'clip' | 'live';
  readonly horizonSeconds: number;
  readonly entries: readonly WorldLogEntry[];
  /** Chained frame digest at export time. */
  readonly digest: string;
}

/* -------------------------------------------------------------- snapshots */

/** Scene-frame actor row exposed to clients. */
export interface WorldActorState {
  readonly id: string;
  readonly kind: ActorKind;
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly present: boolean;
  readonly s: number;
  readonly laneRsl: string | null;
}

export interface WorldSnapshot {
  readonly tS: number;
  readonly tick: number;
  readonly done: boolean;
  readonly actors: readonly WorldActorState[];
}

export interface AdvanceResult {
  readonly tS: number;
  readonly tick: number;
  readonly done: boolean;
  readonly events: readonly SimEvent[];
  readonly actors: readonly WorldActorState[];
}

export interface WorldSessionOptions {
  readonly input: ScenarioSource;
  readonly graph: LaneGraph;
  /**
   * Finite horizon in clip mode (default 120 s). Ignored in live mode, whose
   * engine is unbounded and does not retain trace history.
   */
  readonly horizonSeconds?: number;
  /** Opt-in continuously advancing world. Default keeps finite clip semantics. */
  readonly mode?: 'clip' | 'live';
}

/* ------------------------------------------------------------ truth pull */

/**
 * One pull-based truth subscriber. The native world enqueues already-framed
 * bytes on its tick path and never calls consumer code; `pull()` drains the
 * framed bytes, `frames()` decodes them.
 */
export class TruthSubscription {
  private readonly decoder = new TruthStreamClient();

  constructor(readonly native: NativeTruthSubscription) {}

  /** Every queued frame as `u32le length || msgpack(TruthFrame)`, oldest first. */
  pull(): Uint8Array[] {
    return guard(() => this.native.drainFrames());
  }

  /** Every queued frame, decoded. */
  frames(): TruthFrame[] {
    const out: TruthFrame[] = [];
    for (const framed of this.pull()) out.push(...this.decoder.push(framed));
    return out;
  }

  get stats(): TruthSubscriptionStats {
    return { queued: this.native.queued, dropped: this.native.dropped };
  }

  get active(): boolean {
    return this.native.active;
  }

  close(): void {
    this.native.close();
  }
}

/* ------------------------------------------------------------ the session */

const WORLD_POSE_ROW = 5;

export class WorldSession {
  readonly native: NativeWorldSession;
  readonly mode: 'clip' | 'live';

  constructor(module: NativeModule, engine: EngineRuntime, options: WorldSessionOptions) {
    this.mode = options.mode ?? 'clip';
    const scenario = engine.scenario(options.input);
    const optionsJson = JSON.stringify({ mode: this.mode, ...(options.horizonSeconds === undefined ? {} : { horizonSeconds: options.horizonSeconds }) });
    this.native = guard(() => new module.WorldSession(scenario, options.graph, optionsJson));
  }

  /** Simulation time at the current instant. */
  time(): number {
    return this.native.time;
  }

  /** Ticks advanced past t = 0. */
  tick(): number {
    return this.native.tick;
  }

  /** Chained frame digest so far. */
  digest(): string {
    return this.native.digest;
  }

  /** Subscribe to future atomic truth frames; bounded, drop-oldest. */
  subscribeTruth(options: { readonly capacity?: number } = {}): TruthSubscription {
    return new TruthSubscription(guard(() => this.native.subscribe(options.capacity ?? null)));
  }

  snapshot(): WorldSnapshot {
    const view = this.native.snapshot();
    const actors: WorldActorState[] = [];
    for (let i = 0; i < view.actorIds.length; i += 1) {
      const base = i * WORLD_POSE_ROW;
      actors.push({
        id: view.actorIds[i]!,
        kind: view.kinds[i] as ActorKind,
        x: view.pose[base]!,
        z: view.pose[base + 1]!,
        headingRad: view.pose[base + 2]!,
        speedMps: view.pose[base + 3]!,
        s: view.pose[base + 4]!,
        present: view.present[i] !== 0,
        laneRsl: view.laneRsls[i] ?? null,
      });
    }
    return { tS: view.tS, tick: view.tick, done: view.done, actors };
  }

  exportLog(): WorldSessionLog {
    return JSON.parse(guard(() => this.native.logJson())) as WorldSessionLog;
  }

  /** Apply one command for `clientId`/`seq`; the outcome (including rejections) is logged. */
  applyCommand(clientId: string, seq: number, command: WorldCommand): CommandOutcome {
    return JSON.parse(guard(() => this.native.command(JSON.stringify(command), clientId, seq))) as CommandOutcome;
  }

  /**
   * Hold one actor's pedals and wheel until replaced; `null` releases the
   * actor back to its scenario controller. Called once per render frame by a
   * driving client, so it goes through the typed native entry point instead
   * of a JSON command document — same `clientId`/`seq` bookkeeping and same
   * replayable log entry as {@link applyCommand}.
   */
  setDriverCommand(clientId: string, seq: number, actorId: string, command: DriverCommand | null): CommandOutcome {
    return JSON.parse(guard(() => this.native.setDriverCommand(
      actorId,
      command?.throttle ?? null,
      command?.brake ?? null,
      command?.steer ?? null,
      command?.handbrake ?? null,
      clientId,
      seq,
    ))) as CommandOutcome;
  }

  /** Advance the engine by `ticks`, hashing every frame into the digest. */
  advance(ticks: number): AdvanceResult {
    if (!Number.isInteger(ticks) || ticks <= 0) throw new Error(`ticks must be a positive integer, got ${String(ticks)}`);
    return JSON.parse(guard(() => this.native.advance(ticks))) as AdvanceResult;
  }

  /** Opaque, portable continuation state. */
  checkpoint(): Uint8Array {
    return guard(() => this.native.checkpoint());
  }

  restore(checkpoint: Uint8Array): void {
    guard(() => this.native.restore(checkpoint));
  }
}

/* ----------------------------------------------------------------- replay */

export interface ReplayResult {
  readonly digest: string;
  /** True when every log entry reproduced its recorded outcome. */
  readonly outcomesMatch: boolean;
  /** First divergent entry index, when any. */
  readonly divergedAt: number | null;
}

/**
 * Replay a session log against the same base input + graph. Determinism
 * contract: the returned digest equals `log.digest` and every command
 * reproduces its recorded outcome (including rejections).
 */
export function replayWorldSessionLog(
  module: NativeModule,
  engine: EngineRuntime,
  log: WorldSessionLog,
  options: { input: ScenarioSource; graph: LaneGraph },
): ReplayResult {
  const scenario = engine.scenario(options.input);
  return JSON.parse(guard(() => module.replayWorldLog(JSON.stringify(log), scenario, options.graph))) as ReplayResult;
}
