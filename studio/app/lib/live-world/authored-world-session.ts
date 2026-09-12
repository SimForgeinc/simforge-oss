import {
  isRoadActorKind,
  type LaneGraph,
  type SimScenarioInput,
} from '@simforge-oss/engine';
import type { CommandOutcome, SessionRuntime, WorldSession } from '@simforge-oss/training-env/browser';

import type { ControlInput, DriverCommand } from './types';

export function createAuthoredWorldSession(sessions: SessionRuntime, input: SimScenarioInput, graph: LaneGraph): WorldSession {
  return sessions.world({ input, graph, mode: 'live' });
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
  // No physics-mode check: `dynamic-v1` is the only motion backend, and a
  // document that pinned the removed `kinematic-v1` migrates on parse.
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

/**
 * Whether the native binding behind a session can hold a driver command.
 *
 * The probe is on the *binding*, not on `WorldSession`: the wrapper always
 * declares `setDriverCommand`, while the wasm build the browser loads only
 * gained it when it was last rebuilt. Calling into a binding that lacks it
 * throws, so the fallback has to be chosen before the call, not after.
 */
export function heldDriverCommandSupported(world: WorldSession): boolean {
  const native = world.native as { setDriverCommand?: unknown };
  return typeof native.setDriverCommand === 'function';
}

/**
 * Hold the ego's pedals and wheel, or release them back to the scenario
 * controller with a `null` command.
 *
 * Where the binding has no held-command surface, the same intent goes through
 * the per-tick `act` command: the handbrake folds into the brake pedal, which
 * is the closest that command can express. The worker reports which path is in
 * use so the UI can say so rather than quietly implying a handbrake that does
 * not exist.
 */
export function applyDriverCommand(
  world: WorldSession,
  actorId: string,
  command: DriverCommand | null,
  sequence: number,
): CommandOutcome {
  if (heldDriverCommandSupported(world)) {
    return world.setDriverCommand('drive-worker', sequence, actorId, command);
  }
  return world.applyCommand('drive-worker', sequence, {
    kind: 'act',
    actorId,
    action: {
      motionDirection: 1,
      control: {
        steer: command?.steer ?? 0,
        throttle: command?.throttle ?? 0,
        brake: command ? Math.max(command.brake, command.handbrake === true ? 1 : 0) : 0,
      },
    },
  });
}
