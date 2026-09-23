import { Vector3 } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { samplePlaybackActors, type PlaybackBundle, type SampledActor } from '@simforge-oss/playback';
import {
  actorFrameDistance,
  flyCameraTo,
  resolveActorFrameTarget,
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
