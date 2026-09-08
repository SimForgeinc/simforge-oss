import {
  isRoadActorKind,
  resolvePhysicsConfig,
  type LaneGraph,
  type SimScenarioInput,
} from '@simforge-oss/engine';
import type { SessionRuntime, TruthFrame, WorldSession } from '@simforge-oss/training-env/browser';

import type { ControlInput } from './types';

export function createAuthoredWorldSession(sessions: SessionRuntime, input: SimScenarioInput, graph: LaneGraph): WorldSession {
  return sessions.world({ input, graph, mode: 'live' });
}

/**
 * How a designated ego owns the authored world.
 *
 * `take` keeps the authored clip boundary: the world parks at the document's
 * own `clipSeconds`, so a recorded drive is exactly one clip long. `free`
 * lets the ego keep driving the live native world past that boundary; the
 * engine itself is unbounded in live mode, only the transport enforces it.
 */
export type AuthoredDriveMode = 'free' | 'take';

export function authoredWorldUnbounded(egoActorId: string | null, mode: AuthoredDriveMode): boolean {
  return egoActorId !== null && mode === 'free';
}

/** Fixed steps the transport may take this interval; the clip boundary binds only for a bounded world. */
export function authoredAdvanceTicks(
  budgetTicks: number,
  timeS: number,
  clipSeconds: number,
  dt: number,
  unbounded: boolean,
): number {
  if (unbounded) return Math.max(0, budgetTicks);
  const remainingS = Math.max(0, clipSeconds - timeS);
  return Math.max(0, Math.min(budgetTicks, Math.ceil(remainingS / dt - 1e-9)));
}
export interface AuthoredPlaybackBudget {
  readonly ticks: number;
  readonly remainderS: number;
  readonly lagS: number;
}

export function authoredPlaybackBudget(
  elapsedWallS: number,
  accumulatedS: number,
  dt: number,
  maxTicks: number,
): AuthoredPlaybackBudget {
  if (!Number.isFinite(elapsedWallS) || elapsedWallS < 0) {
    throw new RangeError(`elapsed wall time must be finite and non-negative, got ${String(elapsedWallS)}`);
  }
  if (!Number.isFinite(accumulatedS) || accumulatedS < 0) {
    throw new RangeError(`accumulated time must be finite and non-negative, got ${String(accumulatedS)}`);
  }
  if (!Number.isFinite(dt) || dt <= 0) {
    throw new RangeError(`fixed step must be finite and positive, got ${String(dt)}`);
  }
  if (!Number.isInteger(maxTicks) || maxTicks <= 0) {
    throw new RangeError(`maximum tick budget must be a positive integer, got ${String(maxTicks)}`);
  }

  const availableS = accumulatedS + elapsedWallS;
  const availableTicks = Math.floor((availableS + dt * 1e-9) / dt);
  const ticks = Math.min(availableTicks, maxTicks);
  // Discard lag beyond a single step rather than banking it. Retaining it made
  // a stall -- a compile, a slow frame, four camera panes rendering -- replay
  // later at the catch-up cap, so the clip advanced in bursts instead of at
  // wall-clock rate: seconds of scenario in a fraction of a second. Real-time
  // playback skips missed time; only `lagS` records what was dropped.
  const remainderS = Math.min(Math.max(0, availableS - ticks * dt), dt);
  const droppedS = Math.max(0, availableS - ticks * dt - remainderS);
  return {
    ticks,
    remainderS,
    lagS: droppedS,
  };
}

export function selectAuthoredEgoActor(
  input: SimScenarioInput,
  preferredActorId: string | null = null,
): string | null {
  const candidates = input.actors.filter((actor) =>
    isRoadActorKind(actor.kind) && !actor.static,
  );
  if (preferredActorId) {
    const preferred = candidates.find((actor) =>
      actor.id === preferredActorId || authoredRoleIdForActor(actor) === preferredActorId,
    );
    if (preferred) return preferred.id;
  }
  return candidates
    .map((actor, index) => ({ actor, index, score: routeRunwayScore(actor) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.actor.id ?? null;
}

export function authoredRoleIdForActor(
  actor: SimScenarioInput['actors'][number],
): string | null {
  return actor.tags.find((tag) => tag.startsWith('role:'))?.slice('role:'.length) ?? null;
}

function routeRunwayScore(actor: SimScenarioInput['actors'][number]): number {
  const route = actor.behavior.route;
  if (route.kind === 'follow') return route.maxLengthM;
  if (route.kind === 'lanePath') {
    const stationM = actor.initial.laneRef?.s ?? 0;
    return route.lanes.length * 1_000_000 - stationM;
  }
  if (route.kind === 'timedPolyline') return route.points.at(-1)?.timeS ?? 0;
  let distanceM = 0;
  for (let index = 1; index < route.points.length; index += 1) {
    const previous = route.points[index - 1]!;
    const current = route.points[index]!;
    distanceM += Math.hypot(current.x - previous.x, current.z - previous.z);
  }
  return distanceM;
}

export function authoredClipCompleted(timeS: number, durationS: number): boolean {
  return Number.isFinite(timeS)
    && Number.isFinite(durationS)
    && durationS >= 0
    && timeS >= durationS - 1e-9;
}

export function authoredPlaybackRequiresReset(
  completed: boolean,
  timeS: number,
  durationS: number,
): boolean {
  return completed || authoredClipCompleted(timeS, durationS);
}

export function assertControllableActor(input: SimScenarioInput, actorId: string): void {
  const actor = input.actors.find((candidate) => candidate.id === actorId);
  if (!actor) throw new Error(`Cannot designate unknown authored actor ${actorId} as ego`);
  if (!isRoadActorKind(actor.kind)) {
    throw new Error(`Authored actor ${actorId} (${actor.kind}) is not a controllable road vehicle`);
  }
  if (actor.static) throw new Error(`Authored actor ${actorId} is static and has no controllable dynamics`);
  if (resolvePhysicsConfig(input).mode !== 'dynamic-v1') {
    throw new Error(`Authored actor ${actorId} cannot be driven because the world does not use dynamic-v1 physics`);
  }
}

export function applyEgoControl(
  world: WorldSession,
  actorId: string,
  input: ControlInput,
  sequence: number,
) {
  if (input.actorId !== actorId) {
    throw new Error(`Control target ${input.actorId} is not the designated ego ${actorId}`);
  }
  return world.applyCommand('drive-worker', sequence, {
    kind: 'act',
    actorId,
    action: {
      motionDirection: input.reverse ? -1 : 1,
      control: {
        steer: input.steer,
        throttle: input.throttle,
        brake: input.brake,
      },
    },
  });
}

/* ------------------------------------------------------------- takes */

/** One engine tick of the ego during a recorded take: scene y-up metres and radians. */
export interface ManualDriveSample {
  readonly timeS: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
}

/**
 * The actual simulated path of a bounded take, one sample per engine tick on
 * the authoritative simulation clock from `t = 0` through the clip end
 * inclusive. Nothing is decimated or synthesised from input.
 */
export interface ManualDriveRecording {
  readonly version: 1;
  readonly clipSeconds: number;
  readonly samples: readonly ManualDriveSample[];
}

/**
 * The take's first sample. The native truth stream publishes a frame after
 * each tick, so the initial state at t = 0 comes from the world snapshot,
 * which carries the same scene xz / heading / speed the frames do (the
 * native frame has no height channel: `position[1]` is 0, matched here).
 */
export function initialTakeSample(world: WorldSession, egoActorId: string, motionDirection: 1 | -1): ManualDriveSample {
  const snapshot = world.snapshot();
  const ego = snapshot.actors.find((actor) => actor.id === egoActorId);
  if (!ego || !ego.present) throw new Error(`Take aborted: ego ${egoActorId} is not present at t=${snapshot.tS.toFixed(3)} s`);
  return {
    timeS: snapshot.tS,
    x: ego.x,
    y: 0,
    z: ego.z,
    headingRad: ego.headingRad,
    speedMps: motionDirection * Math.abs(ego.speedMps),
  };
}

/**
 * Append the ego's state from every truth frame. Frames are the native
 * session's own per-tick scene-state (already y-up scene frame), so this is
 * a projection, not a conversion. `speedMps` is signed longitudinal speed:
 * the frame carries an unsigned magnitude along the heading, so the sign
 * comes from the ego's commanded motion direction at those ticks (zero-order
 * held, exactly as the engine applied it). A frame without the ego present
 * means the take can no longer be an honest recording; it fails rather than gaps.
 */
export function appendTakeSamples(
  samples: ManualDriveSample[],
  frames: readonly TruthFrame[],
  egoActorId: string,
  motionDirection: 1 | -1,
): void {
  for (const frame of frames) {
    const ego = frame.scene.actors.find((actor) => actor.id === egoActorId);
    if (!ego || ego.kind === 'despawn') {
      throw new Error(`Take aborted: ego ${egoActorId} is not present at t=${frame.timeSec.toFixed(3)} s`);
    }
    const last = samples[samples.length - 1];
    if (last && frame.timeSec <= last.timeS + 1e-9) continue;
    samples.push({
      timeS: frame.timeSec,
      x: ego.position[0],
      y: ego.position[1],
      z: ego.position[2],
      headingRad: ego.yawRad,
      speedMps: motionDirection * Math.hypot(ego.velocity[0], ego.velocity[2]),
    });
  }
}

/** Seal a take: the sample set must cover every tick of the clip, or the take is not a recording. */
export function finishTakeRecording(
  samples: readonly ManualDriveSample[],
  clipSeconds: number,
  dt: number,
): ManualDriveRecording {
  const expected = Math.round(clipSeconds / dt) + 1;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || Math.abs(first.timeS) > 1e-9 || !authoredClipCompleted(last.timeS, clipSeconds)) {
    throw new Error(
      `Take is incomplete: samples span ${first?.timeS ?? 'none'}..${last?.timeS ?? 'none'} s of a ${clipSeconds} s clip`,
    );
  }
  if (samples.length !== expected) {
    throw new Error(`Take is incomplete: ${samples.length} samples captured, ${expected} engine ticks expected`);
  }
  return { version: 1, clipSeconds, samples };
}
