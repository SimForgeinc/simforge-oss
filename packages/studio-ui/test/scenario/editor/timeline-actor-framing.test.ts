import { Vector3 } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { samplePlaybackActors, type PlaybackBundle, type SampledActor } from '@simforge-oss/playback';
import {
  actorFrameDistance,
  flyCameraTo,
  followActorCamera,
  resolveActorFrameTarget,
  shouldReleaseFollowedActor,
} from '../../../src/scenario/editor/camera-framing';

afterEach(() => vi.unstubAllGlobals());

const AUTHORED = {
  x: 0,
  y: 0,
  z: 0,
  dims: { l: 4.5, h: 1.5 },
};

function sample(overrides: Partial<SampledActor> = {}): SampledActor {
  return {
    id: 'vehicle-1',
    catalogId: 'vehicle.car' as SampledActor['catalogId'],
    dims: { l: 4.5, w: 1.8, h: 1.5 } as SampledActor['dims'],
    x: 120,
    z: -45,
    headingRad: 0,
    speedMps: 8,
    present: true,
    static: false,
    motionDirection: 1,
    ...overrides,
  };
}

/** A car that drives 5 m east of its spawn over half a second. */
function drivingBundle(): PlaybackBundle {
  const times = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  return {
    actors: [{
      id: 'vehicle-1',
      kind: 'car',
      static: false,
      tags: [],
      catalogId: 'vehicle.sedan',
      modelBasis: 'kind-default',
      dims: { l: 4.7, w: 1.82, h: 1.45 },
      initial: { x: 0, z: 0, headingRad: 0 },
    }],
    trace: {
      ticks: {
        t: times,
        actors: {
          'vehicle-1': {
            x: [0, 1, 2, 3, 4, 5],
            z: times.map(() => 0),
            headingRad: times.map(() => 0),
            speedMps: times.map(() => 10),
            lateralOffsetM: times.map(() => 0),
            motionDirection: times.map(() => 1 as const),
            laneRsl: times.map(() => null),
            s: [0, 1, 2, 3, 4, 5],
            present: times.map(() => 1),
          },
        },
        signals: {},
      },
      events: [],
      metrics: { collisions: [] },
    },
  } as never;
}

it('tracks the playhead through the real playback sampler', () => {
  // Closes the loop the bug lived in: the trace, not the authored spawn pose,
  // is what the author sees at t=0.4 s, so that is what the camera must frame.
  const bundle = drivingBundle();
  const framed = [0, 0.4].map((time) => resolveActorFrameTarget({
    actorId: 'vehicle-1',
    inspecting: true,
    sampledActors: samplePlaybackActors(bundle, time),
    authored: { ...AUTHORED, x: 0, z: 0 },
    sampleHeight: () => 0,
  }));

  expect(framed[0]).toMatchObject({ x: 0, z: 0 });
  expect(framed[1]).toMatchObject({ x: 4, z: 0 });
});

it('frames the playhead pose while playback presents the scene, not the spawn placement', () => {
  const target = resolveActorFrameTarget({
    actorId: 'vehicle-1',
    inspecting: true,
    sampledActors: [sample()],
    authored: AUTHORED,
    sampleHeight: () => 3.5,
  });

  expect(target).toMatchObject({ x: 120, y: 3.5, z: -45 });
});

it('keeps the authored placement while the editor owns the scene', () => {
  const target = resolveActorFrameTarget({
    actorId: 'vehicle-1',
    inspecting: false,
    sampledActors: [sample()],
    authored: AUTHORED,
    sampleHeight: () => 3.5,
  });

  expect(target).toMatchObject({ x: 0, y: 0, z: 0 });
});

it('falls back to the authored placement for an actor absent at the playhead', () => {
  // Not spawned yet or already removed: it has no on-screen position to fly to.
  const target = resolveActorFrameTarget({
    actorId: 'vehicle-1',
    inspecting: true,
    sampledActors: [sample({ present: false })],
    authored: AUTHORED,
    sampleHeight: () => 3.5,
  });

  expect(target).toMatchObject({ x: 0, y: 0, z: 0 });
});

it('reuses the authored height when the ground index cannot answer yet', () => {
  const target = resolveActorFrameTarget({
    actorId: 'vehicle-1',
    inspecting: true,
    sampledActors: [sample()],
    authored: { ...AUTHORED, y: 12 },
    sampleHeight: () => null,
  });

  expect(target).toMatchObject({ x: 120, y: 12, z: -45 });
});

it('frames nothing when the actor is neither authored nor sampled', () => {
  expect(resolveActorFrameTarget({
    actorId: 'ghost',
    inspecting: true,
    sampledActors: [sample()],
    authored: null,
    sampleHeight: () => 0,
  })).toBeNull();
});

it('flies to the requested point along the current view direction, and cancels on demand', () => {
  const frames: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => cancelled.push(handle));

  const views: Array<{ position: Vector3; target: Vector3 }> = [];
  const viewer = {
    controls: {
      getView: () => ({ position: [0, 20, 0] as const, target: [0, 0, 0] as const }),
      setView: (position: Vector3, target: Vector3) => {
        views.push({ position: position.clone(), target: target.clone() });
      },
    },
  };

  const destination = new Vector3(120, 4, -45);
  const cancel = flyCameraTo(viewer, destination, actorFrameDistance({ l: 4.5, h: 1.5 }));

  // The flight advances toward the sampled pose and ends looking at it.
  frames.splice(0).forEach((frame) => frame(performance.now()));
  expect(views.at(-1)!.target.length()).toBeGreaterThan(0);
  frames.splice(0).forEach((frame) => frame(performance.now() + 1000));
  const settled = views.at(-1)!;
  expect(settled.target.distanceTo(destination)).toBeLessThan(0.001);
  // Direction preserved: the camera stays above its target, as it started.
  expect(settled.position.y).toBeGreaterThan(settled.target.y);
  expect(settled.position.distanceTo(destination)).toBeCloseTo(20.25, 2);

  cancel();
  expect(cancelled.length).toBeLessThanOrEqual(1);
});

/**
 * A live camera rig: `setView` is what the controls would do, so the next
 * `getView` reports the pose the previous frame left. Without this the offset
 * cannot be observed to survive, which is the whole point of the follow.
 */
function trackingViewer(initial: { position: Vector3; target: Vector3 }) {
  let position = initial.position.clone();
  let target = initial.target.clone();
  return {
    controls: {
      getView: () => ({
        position: [position.x, position.y, position.z] as const,
        target: [target.x, target.y, target.z] as const,
      }),
      setView: (nextPosition: Vector3, nextTarget: Vector3) => {
        position = nextPosition.clone();
        target = nextTarget.clone();
      },
    },
    get pose() {
      return { position: position.clone(), target: target.clone() };
    },
  };
}

/**
 * A frame clock that honours cancellation.
 *
 * `cancelAnimationFrame` has to actually drop the pending callback, or a test cannot tell a
 * cancelled loop from a running one — it would keep driving the camera and still pass.
 */
function stubFrames() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pending.delete(handle);
  });
  return {
    /** Run every queued frame at `now`, as the browser would. */
    advance(now: number) {
      const due = [...pending.entries()];
      pending.clear();
      due.forEach(([, frame]) => frame(now));
    },
  };
}

it('follows a moving actor instead of stopping where it was picked', () => {
  const clock = stubFrames();
  const viewer = trackingViewer({
    position: new Vector3(0, 20, 20),
    target: new Vector3(0, 0, 0),
  });
  let x = 0;
  const cancel = followActorCamera(viewer, () => ({ x, y: 0, z: 0, dims: { l: 4.5, h: 1.5 } }));

  // Settle the initial ease onto the car.
  const start = performance.now();
  clock.advance(start);
  clock.advance(start + 1000);
  expect(viewer.pose.target.x).toBeCloseTo(0, 3);

  // The car drives away; the camera must go with it rather than hold the pick pose.
  x = 60;
  clock.advance(start + 1016);
  expect(viewer.pose.target.x).toBeCloseTo(60, 3);
  x = 120;
  clock.advance(start + 1032);
  expect(viewer.pose.target.x).toBeCloseTo(120, 3);

  cancel();
});

it('never changes the orbit while following: distance and angle are preserved exactly', () => {
  const clock = stubFrames();
  const startPosition = new Vector3(10, 30, 40);
  const startTarget = new Vector3(0, 0, 0);
  const viewer = trackingViewer({ position: startPosition, target: startTarget });
  const offset = startPosition.clone().sub(startTarget);

  let x = 0;
  const cancel = followActorCamera(viewer, () => ({ x, y: 0, z: 0, dims: { l: 4.5, h: 1.5 } }));

  const start = performance.now();
  clock.advance(start);
  clock.advance(start + 1000);
  for (const next of [25, 90, 240]) {
    x = next;
    clock.advance(start + 1000 + next);
    const pose = viewer.pose;
    // The rig translates: the camera-to-target vector is bit-for-bit the one the
    // author left, so neither the dolly distance nor the orbit angles moved.
    expect(pose.position.clone().sub(pose.target).distanceTo(offset)).toBeLessThan(1e-6);
  }

  cancel();
});

it('keeps an orbit the author performs mid-follow', () => {
  const clock = stubFrames();
  const viewer = trackingViewer({
    position: new Vector3(0, 20, 20),
    target: new Vector3(0, 0, 0),
  });
  let x = 0;
  const cancel = followActorCamera(viewer, () => ({ x, y: 0, z: 0, dims: { l: 4.5, h: 1.5 } }));
  const start = performance.now();
  clock.advance(start);
  clock.advance(start + 1000);

  // The author orbits: the controls move the camera around the target we set.
  const orbited = viewer.pose;
  viewer.controls.setView(
    new Vector3(orbited.target.x - 30, orbited.target.y + 10, orbited.target.z),
    orbited.target,
  );
  const authorOffset = viewer.pose.position.clone().sub(viewer.pose.target);

  x = 75;
  clock.advance(start + 1100);
  const pose = viewer.pose;
  expect(pose.target.x).toBeCloseTo(75, 3);
  // Their angle survives the next frames rather than snapping back.
  expect(pose.position.clone().sub(pose.target).distanceTo(authorOffset)).toBeLessThan(1e-6);

  cancel();
});

it('holds still while the actor has no on-screen pose', () => {
  const clock = stubFrames();
  const viewer = trackingViewer({
    position: new Vector3(0, 20, 20),
    target: new Vector3(0, 0, 0),
  });
  let present = true;
  const cancel = followActorCamera(
    viewer,
    () => (present ? { x: 50, y: 0, z: 0, dims: { l: 4.5, h: 1.5 } } : null),
  );
  const start = performance.now();
  clock.advance(start);
  clock.advance(start + 1000);
  const settled = viewer.pose;

  // Despawned: the camera must not dive at the origin.
  present = false;
  clock.advance(start + 1100);
  expect(viewer.pose.position.distanceTo(settled.position)).toBeLessThan(1e-6);
  expect(viewer.pose.target.distanceTo(settled.target)).toBeLessThan(1e-6);

  cancel();
});

it('releases the camera when the followed actor stops being selected', () => {
  // Unclicking the car, and closing its details panel, both end at an empty actor selection.
  expect(shouldReleaseFollowedActor({ followedActorId: 'vehicle-1', selection: [], presenting: true })).toBe(true);
  // Selecting a different car: the previous follow is over either way, and the new pick starts its
  // own.
  expect(shouldReleaseFollowedActor({ followedActorId: 'vehicle-1', selection: ['vehicle-2'], presenting: true })).toBe(
    true,
  );
});

it('keeps following while its actor is still selected, and never releases what it is not following', () => {
  expect(shouldReleaseFollowedActor({ followedActorId: 'vehicle-1', selection: ['vehicle-1'], presenting: true })).toBe(
    false,
  );
  // A multi-select that still contains the followed car is not a deselection.
  expect(
    shouldReleaseFollowedActor({ followedActorId: 'vehicle-1', selection: ['vehicle-2', 'vehicle-1'], presenting: true }),
  ).toBe(false);
  // Not following: a one-shot flight must not be cancelled by an unrelated selection change.
  expect(shouldReleaseFollowedActor({ followedActorId: null, selection: [], presenting: true })).toBe(false);
  // No editor state yet would otherwise cancel the follow on the frame it started.
  expect(shouldReleaseFollowedActor({ followedActorId: 'vehicle-1', selection: undefined, presenting: true })).toBe(
    false,
  );
});

it('stops moving the camera once the follow is cancelled', () => {
  // The release path is only worth anything if cancelling actually detaches the camera: a stale rAF
  // loop would keep dragging the view to a car the author has let go of.
  const clock = stubFrames();
  const viewer = trackingViewer({
    position: new Vector3(0, 20, 20),
    target: new Vector3(0, 0, 0),
  });
  let x = 0;
  const cancel = followActorCamera(viewer, () => ({ x, y: 0, z: 0, dims: { l: 4.5, h: 1.5 } }));
  const start = performance.now();
  clock.advance(start);
  clock.advance(start + 1000);
  expect(viewer.pose.target.x).toBeCloseTo(0, 3);

  cancel();
  x = 250;
  clock.advance(start + 1100);
  clock.advance(start + 1200);
  expect(viewer.pose.target.x).toBeCloseTo(0, 3);
});

it('releases the camera when playback stops owning the scene', () => {
  /**
   * The reachable release while a follow is live. During a simulation the details panel has no close
   * button and viewport clicks do not deselect, so the selection never changes — leaving the
   * simulation is the author's actual way out, and without this the loop outlives it and keeps
   * writing the view every frame.
   */
  expect(
    shouldReleaseFollowedActor({
      followedActorId: 'vehicle-1',
      selection: ['vehicle-1'],
      presenting: false,
    }),
  ).toBe(true);
  // Still nothing to release when the camera was never following.
  expect(
    shouldReleaseFollowedActor({ followedActorId: null, selection: ['vehicle-1'], presenting: false }),
  ).toBe(false);
  // A follow whose actor is selected and whose playback is live continues.
  expect(
    shouldReleaseFollowedActor({
      followedActorId: 'vehicle-1',
      selection: ['vehicle-1'],
      presenting: true,
    }),
  ).toBe(false);
});
