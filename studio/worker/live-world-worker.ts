/// <reference lib="webworker" />

import {
  parseSimScenarioInput,
  type ActorKind,
  type LaneGraph,
  type SimScenarioInput,
} from '@simforge-oss/engine';
import {
  loadSessions,
  TruthStreamClient,
  type SessionRuntime,
  type TruthSubscription,
  type WorldSession,
} from '@simforge-oss/training-env/browser';
import { loadMapGraph, type MapGraphSources, type StaticColliderDiagnostics } from '@simforge-oss/playback';

import type {
  LiveWorldWorkerRequest,
  LiveWorldWorkerResponse,
} from '../app/lib/live-world/worker-protocol';
import type { DriveControlSource } from '../app/lib/live-world/types';
import {
  applyDriverCommand,
  applyEgoControl,
  appendTakeSamples,
  assertControllableActor,
  authoredAdvanceTicks,
  authoredPlaybackBudget,
  authoredClipCompleted,
  authoredPlaybackRequiresReset,
  authoredWorldUnbounded,
  createAuthoredWorldSession,
  heldDriverCommandSupported,
  finishTakeRecording,
  holdEgoNeutral,
  initialTakeSample,
  releaseEgo,
  type AuthoredDriveMode,
  type ManualDriveSample,
} from '../app/lib/live-world/authored-world-session';
import { WorkerReadyGate } from '../app/lib/live-world/worker-ready-gate';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let sessions: SessionRuntime | null = null;
let world: WorldSession | null = null;
let truth: TruthSubscription | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let commandSequence = 0;
let closed = false;
let authoredInput: SimScenarioInput | null = null;
let authoredGraph: LaneGraph | null = null;
let egoActorId: string | null = null;
let driveMode: AuthoredDriveMode = 'take';
let controlSource: DriveControlSource = 'human';
let playing = true;
let inspecting = false;
let completed = false;
/**
 * A bounded take in progress: the ego's per-tick state read back from the
 * native truth stream. Any rebuild of the world (reset, seek back, replay)
 * discards it; only a clip that ran to its end seals a recording.
 */
let take: { samples: ManualDriveSample[]; decoder: TruthStreamClient } | null = null;
/** Increments on every rebuild; frames after a `world-reset` belong to the new generation. */
let worldGeneration = 0;
let authoredTickHz = 20;
/** A game session: the world runs past the document's clip and never parks. */
let endless = false;
let authoredClockLastWallTimeMs: number | null = null;
let authoredClockRemainderS = 0;
let lastAuthoredLagWarningMs = Number.NEGATIVE_INFINITY;

const AUTHORED_CATCH_UP_INTERVALS = 1.5;
const AUTHORED_LAG_WARNING_INTERVAL_MS = 5_000;


type WorldCommand = Exclude<LiveWorldWorkerRequest, { type: 'init-authored' } | { type: 'preload-map' } | { type: 'close' }>;

/**
 * Commands that arrive while the world is still being built are held and
 * replayed once it exists; see `WorkerReadyGate`. Pedals, transport, ego and
 * control source state an intent, so only the newest of each is kept.
 */
const gate = new WorkerReadyGate<WorldCommand>((message) => {
  switch (message.type) {
    case 'driver-command':
    case 'control':
    case 'planner-action':
    case 'control-source':
    case 'set-ego':
      return message.type;
    case 'transport':
      // A seek is a position, not a play state: keep it apart so a later
      // play does not erase where the page asked to be.
      return message.action === 'seek' ? 'transport:seek' : 'transport';
    default:
      return null;
  }
});

/**
 * The engine and the map's lane graph, started by `preload-map` while the page
 * compiles the scenario, or by `init-authored` when nothing preloaded them.
 * Neither depends on the scenario, so there is one load per worker.
 */
let mapLoad: Promise<{ sessions: SessionRuntime; graph: LaneGraph; collisions: StaticColliderDiagnostics }> | null = null;

function loadMap(sources: MapGraphSources): NonNullable<typeof mapLoad> {
  mapLoad ??= (async () => {
    const runtime = await loadSessions();
    // The drive is a simulation of the same world the editor previews, so its
    // lane graph is built by the same shared builder and carries the same
    // verified static colliders: a car must hit a building here too.
    const mapGraph = await loadMapGraph({ module: runtime.engine.module, sources });
    return { sessions: runtime, graph: mapGraph.graph, collisions: mapGraph.collision.diagnostics };
  })();
  return mapLoad;
}

scope.onmessage = (event: MessageEvent<LiveWorldWorkerRequest>): void => {
  const message = event.data;
  if (message.type === 'preload-map') {
    // A failure here is reported by `init-authored`, which awaits the same load.
    loadMap(message.mapSources).catch(() => {});
    return;
  }
  if (message.type === 'init-authored') {
    void initializeAuthored(message).then(
      () => {
        for (const held of gate.open()) handleCommand(held);
      },
      (error: unknown) => {
        // The world never came up. This error is the one the page must see,
        // so nothing sent after it is answered with a second one.
        gate.fail();
        fail(error);
      },
    );
    return;
  }
  if (message.type === 'close') {
    shutdown();
    return;
  }
  const admission = gate.admit(message);
  if (admission === 'run') {
    handleCommand(message);
    return;
  }
  // A request with an id has a caller waiting on it; everything else was an
  // intent the failed world has no use for.
  if (admission === 'dropped' && 'requestId' in message) {
    fail(new Error('the live world did not start'), message.requestId);
  }
};

function handleCommand(message: WorldCommand): void {
  if (!world || closed) {
    fail(new Error('live world is not running'), 'requestId' in message ? message.requestId : undefined);
    return;
  }

  if (message.type === 'control-source') {
    controlSource = message.source;
    if (egoActorId !== null && !completed) {
      assertOutcome(releaseEgo(world, egoActorId, commandSequence++));
      assertOutcome(holdEgoNeutral(world, egoActorId, commandSequence++));
    }
    return;
  }
  if (message.type === 'planner-action') {
    if (controlSource !== 'jev' || message.actorId !== egoActorId || completed) return;
    assertOutcome(world.applyCommand('drive-worker', commandSequence++, {
      kind: 'act', actorId: message.actorId, action: message.action,
    }));
    return;
  }
  if (message.type === 'set-ego') {
    try {
      controlSource = 'human';
      if (!authoredInput) throw new Error('ego designation is only available for authored worlds');
      if (message.actorId !== null) assertControllableActor(authoredInput, message.actorId);
      // Ownership is explicit in the engine, not implied by the first key:
      // the released actor gets its own behaviour back, the designated one
      // is held neutral so it coasts instead of following its route.
      if (egoActorId !== null && egoActorId !== message.actorId) {
        assertOutcome(releaseEgo(world, egoActorId, commandSequence++));
      }
      egoActorId = message.actorId;
      driveMode = message.mode ?? 'take';
      if (egoActorId !== null) assertOutcome(holdEgoNeutral(world, egoActorId, commandSequence++));
      playing = false;
      inspecting = false;
      // Releasing or re-designating the ego ends any take without a recording.
      take = null;
      // A free-driving ego owns a healthy live world past the clip boundary;
      // the parked flag belongs to the bounded transport only.
      if (authoredWorldUnbounded(egoActorId, driveMode)) completed = false;
      resetAuthoredClock();
      postTransport();
    } catch (error) {
      fail(error);
    }
    return;
  }

  if (message.type === 'begin-take') {
    try {
      beginTake();
    } catch (error) {
      fail(error);
    }
    return;
  }

  if (message.type === 'transport') {
    try {
      applyTransport(message);
    } catch (error) {
      fail(error);
    }
    return;
  }

  if (message.type === 'control') {
    if (controlSource !== 'human') return;
    // A completed authored clip is a healthy, parked world. Keyboard control
    // continues at 20 Hz while Drive is mounted, so ignore it until replay
    // instead of asking a finished WorldSession to accept another act command.
    if (
      authoredInput
      && !endless
      && !authoredWorldUnbounded(egoActorId, driveMode)
      && (completed || authoredClipCompleted(world.time(), authoredInput.clipSeconds))
    ) {
      completed = true;
      playing = false;
      postTransport();
      return;
    }
    const outcome = authoredInput
      ? egoActorId === null
        ? { ok: false, error: 'No authored ego vehicle is selected' }
        : applyEgoControl(world, egoActorId, message.input, commandSequence++)
      : world.applyCommand('drive-worker', commandSequence++, {
          kind: 'act',
          actorId: message.input.actorId,
          action: {
            motionDirection: message.input.reverse ? -1 : 1,
            control: {
              steer: message.input.steer,
              throttle: message.input.throttle,
              brake: message.input.brake,
            },
          },
        });

    if (!outcome.ok) {
      if (authoredInput && /not running/i.test(outcome.error ?? '')) {
        completed = true;
        playing = false;
        postTransport();
        return;
      }
      fail(new Error(outcome.error ?? 'control failed'));
    }
    return;
  }

  if (message.type === 'driver-command') {
    if (controlSource !== 'human') return;
    // As above: a parked clip is not an error, and the driver's pedals simply
    // stop being read until the transport replays.
    if (!endless && authoredInput && (completed || authoredClipCompleted(world.time(), authoredInput.clipSeconds))) {
      completed = true;
      playing = false;
      postTransport();
      return;
    }
    const outcome = applyDriverCommand(world, message.actorId, message.command, commandSequence++);
    if (!outcome.ok) {
      if (/not running/i.test(outcome.error ?? '')) {
        completed = true;
        playing = false;
        postTransport();
        return;
      }
      fail(new Error(outcome.error ?? 'driver command failed'));
    }
    return;
  }

  if (message.type === 'spawn') {
    const outcome = world.applyCommand('drive-worker', commandSequence++, {
      kind: 'spawn',
      spawn: {
        kind: actorKind(message.request.blueprint),
        pose: {
          x: message.request.position.x,
          z: message.request.position.y,
          ...(message.request.headingRad === undefined
            ? {}
            : { headingRad: message.request.headingRad }),
        },
        ...(message.request.speedMps === undefined ? {} : { speedMps: message.request.speedMps }),
      },
    });
    if (!outcome.ok || !outcome.actorIds?.[0]) {
      fail(new Error(outcome.error ?? 'spawn failed'), message.requestId);
      return;
    }
    post({ type: 'result', requestId: message.requestId, actorId: outcome.actorIds[0] });
    return;
  }

  if (message.type === 'despawn') {
    const outcome = world.applyCommand('drive-worker', commandSequence++, {
      kind: 'despawn',
      actorId: message.actorId,
    });
    if (!outcome.ok) {
      fail(new Error(outcome.error ?? 'despawn failed'), message.requestId);
      return;
    }
    post({ type: 'result', requestId: message.requestId });
  }
}

async function initializeAuthored(
  message: Extract<LiveWorldWorkerRequest, { type: 'init-authored' }>,
): Promise<void> {
  if (world || closed) throw new Error('live world worker can only be initialized once');
  if (!Number.isFinite(message.tickHz) || message.tickHz <= 0) {
    throw new Error(`tickHz must be positive, got ${String(message.tickHz)}`);
  }
  authoredInput = parseSimScenarioInput(message.input);
  const loaded = await loadMap(message.mapSources);
  if (closed) return;
  sessions = loaded.sessions;
  authoredGraph = loaded.graph;
  postCollisionDiagnostics(loaded.collisions);
  authoredTickHz = message.tickHz;
  endless = message.endless === true;
  playing = false;
  inspecting = false;
  completed = false;
  const session = rebuildAuthoredWorld();
  timer = setInterval(tick, 1000 / authoredTickHz);
  post({ type: 'ready', heldDriverCommand: heldDriverCommandSupported(session) });
  postTransport();
}

/** Builds the authored world afresh and returns it, so callers can use it without a null check. */
function rebuildAuthoredWorld(): WorldSession {
  if (!sessions || !authoredInput || !authoredGraph) throw new Error('authored world inputs are unavailable');
  truth?.close();
  world = createAuthoredWorldSession(sessions, authoredInput, authoredGraph);
  truth = world.subscribeTruth();
  commandSequence = 0;
  completed = false;
  controlSource = 'human';
  take = null;
  // A rebuilt world knows nothing of the previous one's overrides; the owned
  // ego must be held neutral again before its first tick, or it would start
  // on autopilot until the next control arrives.
  if (egoActorId !== null) assertOutcome(holdEgoNeutral(world, egoActorId, commandSequence++));
  resetAuthoredClock();
  // Frames restart at tick 0. Consumers dedupe by tick, so the new generation
  // is announced first, in order, on the same channel the frames use.
  worldGeneration += 1;
  post({ type: 'world-reset', generation: worldGeneration });
  return world;
}

function applyTransport(message: Extract<LiveWorldWorkerRequest, { type: 'transport' }>): void {
  if (!authoredInput || !world) throw new Error('transport is only available for authored worlds');
  if (message.action === 'reset') {
    playing = false;
    inspecting = false;
    rebuildAuthoredWorld();
    postTransport();
    return;
  }
  if (message.action === 'seek') {
    const seconds = message.seconds;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0 || seconds > authoredInput.clipSeconds) {
      throw new RangeError(`seek time must be within 0..${authoredInput.clipSeconds} seconds`);
    }
    if (seconds + 1e-9 < world.time()) rebuildAuthoredWorld();
    playing = false;
    resetAuthoredClock();
    inspecting = true;
    advanceAuthoredTo(seconds, false);
    completed = authoredClipCompleted(world.time(), authoredInput.clipSeconds);
    postTransport();
    return;
  }
  if (message.action === 'exitInspection') {
    inspecting = false;
    postTransport();
    return;
  }
  if (message.action === 'stop') {
    playing = false;
    resetAuthoredClock();
    postTransport();
    return;
  }
  if (message.action === 'playPause' && playing) {
    playing = false;
    resetAuthoredClock();
  } else {
    // Play from the parked end state means replay, matching media controls.
    // A free-driving ego resumes in place: its world has no end to replay from.
    if (
      !authoredWorldUnbounded(egoActorId, driveMode)
      && authoredPlaybackRequiresReset(completed, world.time(), authoredInput.clipSeconds)
    ) {
      rebuildAuthoredWorld();
    }
    playing = true;
    beginAuthoredClock();
  }
  inspecting = false;
  completed = false;
  postTransport();
}

function beginTake(): void {
  if (!authoredInput || !world) throw new Error('takes are only available for authored worlds');
  if (egoActorId === null) throw new Error('No authored ego vehicle is selected for the take');
  if (driveMode !== 'take') throw new Error('A take needs the bounded drive mode');
  // Every take starts from the document's own initial state so its samples
  // are the clip from t = 0, not a continuation of whatever played before.
  rebuildAuthoredWorld();
  take = { samples: [initialTakeSample(world, egoActorId)], decoder: new TruthStreamClient() };
  playing = true;
  inspecting = false;
  beginAuthoredClock();
  postTransport();
}

function recordTakeFrames(frames: readonly Uint8Array[]): void {
  if (!take || !truth || egoActorId === null) return;
  if (truth.stats.dropped > 0) {
    throw new Error(`Take aborted: the truth stream dropped ${truth.stats.dropped} frame(s)`);
  }
  const decoded = [];
  for (const framed of frames) decoded.push(...take.decoder.push(framed));
  appendTakeSamples(take.samples, decoded, egoActorId);
}

function sealTake(): void {
  if (!take || !authoredInput) return;
  const recording = finishTakeRecording(take.samples, authoredInput.clipSeconds, authoredInput.dt);
  take = null;
  post({ type: 'take-complete', recording });
}


function tick(): void {
  if (!world || !truth || closed || !playing) return;
  try {
    if (authoredInput) {
      const nowMs = performance.now();
      if (authoredClockLastWallTimeMs === null) {
        authoredClockLastWallTimeMs = nowMs;
        postTransport();
        return;
      }

      const elapsedWallS = Math.max(0, (nowMs - authoredClockLastWallTimeMs) / 1_000);
      authoredClockLastWallTimeMs = nowMs;
      const maxTicks = Math.max(
        1,
        Math.ceil(AUTHORED_CATCH_UP_INTERVALS / authoredTickHz / authoredInput.dt),
      );
      const budget = authoredPlaybackBudget(
        elapsedWallS,
        authoredClockRemainderS,
        authoredInput.dt,
        maxTicks,
      );
      authoredClockRemainderS = budget.remainderS;

      if (budget.lagS > 0 && nowMs - lastAuthoredLagWarningMs >= AUTHORED_LAG_WARNING_INTERVAL_MS) {
        post({
          type: 'warning',
          message: `Authored playback is ${(budget.lagS * 1_000).toFixed(0)} ms behind wall clock; `
            + `catch-up is capped at ${maxTicks} fixed steps per worker interval`,
        });
        lastAuthoredLagWarningMs = nowMs;
      }

      // An endless session ignores the clip length: the game's world has no
      // end to park at, and the document's clip is only there because a
      // scenario must declare one. A free-mode ego is unbounded the same way.
      const unbounded = endless || authoredWorldUnbounded(egoActorId, driveMode);
      if (budget.ticks > 0) {
        const ticks = authoredAdvanceTicks(
          budget.ticks,
          world.time(),
          authoredInput.clipSeconds,
          authoredInput.dt,
          unbounded,
        );
        if (ticks > 0) world.advance(ticks);
        const frames = truth.pull();
        if (take) {
          try {
            recordTakeFrames(frames);
          } catch (error) {
            take = null;
            post({ type: 'take-failed', message: error instanceof Error ? error.message : String(error) });
          }
        }
        postTruthFrames(frames, true);
      }
      completed = !unbounded && authoredClipCompleted(world.time(), authoredInput.clipSeconds);

      if (completed) {
        playing = false;
        resetAuthoredClock();
        if (take) {
          try {
            sealTake();
          } catch (error) {
            take = null;
            post({ type: 'take-failed', message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      postTransport();
      return;
    }
    world.advance(1);
    postTruthFrames(truth.pull(), true);
  } catch (error) {
    fail(error);
    shutdown();
  }
}

function beginAuthoredClock(): void {
  authoredClockLastWallTimeMs = performance.now();
  authoredClockRemainderS = 0;
  lastAuthoredLagWarningMs = Number.NEGATIVE_INFINITY;
}

function resetAuthoredClock(): void {
  authoredClockLastWallTimeMs = null;
  authoredClockRemainderS = 0;
}

function advanceAuthoredTo(seconds: number, emitAll: boolean): void {
  if (!world || !truth || !authoredInput) return;
  const remaining = Math.max(0, seconds - world.time());
  const ticks = Math.ceil(remaining / authoredInput.dt - 1e-9);
  if (ticks > 0) world.advance(ticks);
  postTruthFrames(truth.pull(), emitAll);
}

function postTruthFrames(frames: Uint8Array[], emitAll: boolean): void {
  const selected = emitAll ? frames : frames.slice(-1);
  for (const frame of selected) {
    const bytes = frame.slice().buffer;
    scope.postMessage({ type: 'frame', bytes } satisfies LiveWorldWorkerResponse, [bytes]);
  }
}

function postTransport(): void {
  if (!world || !authoredInput) return;
  post({
    type: 'transport',
    playing,
    completed,
    inspecting,
    time: completed ? authoredInput.clipSeconds : Math.max(0, world.time()),
    duration: authoredInput.clipSeconds,
  });
}

function actorKind(blueprint: string): ActorKind {
  const normalized = blueprint.toLowerCase();
  if (normalized.includes('pedestrian') || normalized.startsWith('walker.')) return 'pedestrian';
  if (normalized.includes('motorcycle')) return 'motorcycle';
  if (normalized.includes('bicycle') || normalized.includes('bike')) return 'bicycle';
  if (normalized.includes('truck') || normalized.includes('firetruck')) return 'truck';
  if (normalized.includes('bus')) return 'bus';
  if (normalized.includes('van')) return 'van';
  if (normalized.startsWith('static.') || normalized.includes('prop')) return 'static_object';
  if (normalized.startsWith('vehicle.')) return 'car';
  throw new Error(`unsupported actor blueprint: ${blueprint}`);
}

function assertOutcome(outcome: { ok: boolean; error?: string }): void {
  if (!outcome.ok) throw new Error(outcome.error ?? 'ego ownership command failed');
}

/**
 * Report what the map's collision artifact actually contained, once per world.
 * A map that publishes few colliders is a map whose structures are mostly not
 * solid, and that is worth saying out loud rather than discovering at speed.
 */
function postCollisionDiagnostics(diagnostics: StaticColliderDiagnostics): void {
  post({ type: 'map-collisions', diagnostics });
}

function post(message: LiveWorldWorkerResponse): void {
  if (!closed) scope.postMessage(message);
}

function fail(reason: unknown, requestId?: number): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  post({ type: 'error', message, ...(requestId === undefined ? {} : { requestId }) });
}

function shutdown(): void {
  if (closed) return;
  closed = true;
  if (timer) clearInterval(timer);
  timer = null;
  truth?.close();
  truth = null;
  world = null;
  scope.close();
}
