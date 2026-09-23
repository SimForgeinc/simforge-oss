// @vitest-environment jsdom
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { CityViewer } from '@simforge-oss/viewer';
import type { TruthFrame } from '@simforge-oss/training-env/browser';

import { createTruthViewerBridge, type TruthViewerBridgeOptions } from '../truth-viewer-bridge';

/** The slice of a CityViewer the bridge touches; no WebGL, no map. */
function headlessViewer(): CityViewer {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 4000);
  const target = new Vector3();
  const viewer = {
    scene: new Scene(),
    camera,
    onFrame: undefined as ((dt: number) => void) | undefined,
    getGroundIndex: () => null,
    controls: {
      getView: () => ({ position: [0, 0, 0], target: [0, 0, 0], fov: camera.fov }),
      applyView: (view: { position: [number, number, number]; target: [number, number, number]; fov: number }) => {
        camera.position.set(...view.position);
        target.set(...view.target);
        camera.lookAt(target);
      },
      setEnabled: () => {},
    },
    setCameraPoseConstraintsEnabled: () => {},
  };
  return viewer as unknown as CityViewer;
}

/**
 * One step of a world on a map with a ground surface: the engine reports the
 * body's contact height (`contactZ`), and the scene frame's `position[1]` is 0
 * as it always is. `contactZ: null` is a world without a ground surface.
 */
function frame(tick: number, x: number, actorClass: 'car' | 'truck' = 'car', contactZ: number | null = 41.5): TruthFrame {
  return {
    tick,
    timeSec: tick * 0.02,
    signals: [],
    actors: [{
      id: 'ego',
      class: actorClass,
      dims: { l: 4.5, w: 1.9, h: 1.5 },
      accel: { ax: 0, ay: 0 },
      ...(contactZ === null ? {} : { contact: { z: contactZ, pitchRad: 0, rollRad: 0, wheelDropM: [0, 0, 0, 0] } }),
    }],
    scene: {
      tick,
      t: tick * 0.02,
      actors: [{
        id: 'ego',
        kind: tick === 0 ? 'spawn' : 'update',
        position: [x, 0, 0],
        rotation: [0, 0, 0, 1],
        yawRad: 0,
        velocity: [1, 0, 0],
      }],
    },
  } as unknown as TruthFrame;
}

function bridgeWithSpy(options: TruthViewerBridgeOptions = {}) {
  const viewer = headlessViewer();
  const wall = { ms: 0 };
  const bridge = createTruthViewerBridge(viewer, { layer: 'test', now: () => wall.ms, ...options });
  const sync = vi.spyOn(bridge.actors, 'syncLayer');
  /**
   * x as shown once the render clock has had long enough to reach the newest
   * frame: two displayed frames, ten seconds of wall time apart.
   */
  const renderedX = () => {
    for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
      wall.ms += 10_000;
      viewer.onFrame?.(0.1);
    }
    const call = sync.mock.calls.at(-1);
    return call ? call[1].find((actor) => actor.id === 'ego')?.x ?? null : null;
  };
  const renderedCatalog = () => sync.mock.calls.at(-1)?.[1].find((actor) => actor.id === 'ego')?.catalogId ?? null;
  /** Show one more displayed frame, ten seconds of wall time on. */
  const draw = () => {
    wall.ms += 10_000;
    viewer.onFrame?.(0.1);
    return sync.mock.calls.at(-1)?.[1] ?? null;
  };
  return { bridge, sync, renderedX, renderedCatalog, draw, viewer, wall };
}

describe('truth viewer bridge', () => {
  it('carries each actor\'s travelled distance so ridden two-wheelers pedal by distance', () => {
    const { bridge, sync, renderedX } = bridgeWithSpy();
    // 1 m/s for 50 steps of 0.02 s after spawn = 1 m.
    for (let tick = 0; tick <= 50; tick += 1) bridge.apply(frame(tick, tick * 0.02));
    renderedX();
    const drawn = sync.mock.calls.at(-1)?.[1].find((actor) => actor.id === 'ego');
    expect(drawn?.odometerM).toBeCloseTo(1, 9);
  });


  it('renders a rebuilt world from tick 0 only after an authoritative reset', () => {
    const { bridge, renderedX } = bridgeWithSpy();
    bridge.apply(frame(0, 0));
    bridge.apply(frame(500, 100));
    expect(renderedX()).toBe(100);

    // Out-of-order old frames are still dropped: the world did not restart.
    bridge.apply(frame(3, 0.3));
    expect(renderedX()).toBe(100);

    // Restart / new take: the source announces a reset before the new frames.
    bridge.reset();
    bridge.apply(frame(0, 0));
    expect(renderedX()).toBe(0);
    bridge.apply(frame(1, 0.1));
    expect(renderedX()).toBeCloseTo(0.1, 9);
    bridge.dispose();
  });

  it('renders the authored asset for an authored actor and a class stand-in otherwise', () => {
    const authored = bridgeWithSpy({ authoredCatalogId: (id) => (id === 'ego' ? 'vehicle.bus' : null) });
    authored.bridge.apply(frame(0, 0));
    expect(authored.renderedCatalog()).toBe('vehicle.bus');
    expect(authored.sync.mock.calls.at(-1)?.[1][0]?.catalogIdAuthored).toBe(true);
    authored.bridge.dispose();

    const generic = bridgeWithSpy();
    generic.bridge.apply(frame(0, 0, 'truck'));
    expect(generic.renderedCatalog()).toBe('vehicle.box_truck');
    expect(generic.sync.mock.calls.at(-1)?.[1][0]?.catalogIdAuthored).toBe(false);
    generic.bridge.dispose();
  });

  it('fails visibly instead of substituting a generic body for an unknown authored asset', () => {
    const onError = vi.fn();
    const { bridge, sync } = bridgeWithSpy({ authoredCatalogId: () => 'vehicle.does_not_exist', onError });
    bridge.apply(frame(0, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].message).toMatch(/does_not_exist/);
    expect(sync).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('stands every body on the engine ground contact, blended like the pose', () => {
    const { bridge, draw } = bridgeWithSpy({ now: () => 0, clock: { gainPerS: 0 } });
    bridge.apply(frame(0, 0, 'car', 40));
    expect(bridge.rendered('ego')).toMatchObject({ x: 0, y: 40 });
    bridge.apply(frame(1, 10, 'car', 42));
    // The render clock sits between the two steps: height blends with x.
    const drawn = draw()?.find((actor) => actor.id === 'ego');
    expect(drawn).toBeDefined();
    expect((drawn!.y - 40) / 2).toBeCloseTo(drawn!.x / 10, 9);
    expect(bridge.placingActorIds).toEqual([]);
    bridge.dispose();
  });

  it('holds back and lists a body with no known height instead of drawing it at y = 0', () => {
    // A world without a ground surface, and a viewer whose road is not indexed yet.
    const { bridge, sync, draw } = bridgeWithSpy();
    bridge.apply(frame(0, 0, 'car', null));
    expect(bridge.rendered('ego')).toBeNull();
    expect(sync.mock.calls.at(-1)?.[1]).toEqual([]);
    expect(bridge.placingActorIds).toEqual(['ego']);

    // The engine grounds it on a later step: drawn at the contact, off the list.
    bridge.apply(frame(1, 1, 'car', 7.5));
    const drawn = draw()?.find((actor) => actor.id === 'ego');
    expect(drawn?.y).toBe(7.5);
    expect(bridge.placingActorIds).toEqual([]);

    // A rebuild forgets who was waiting.
    bridge.apply(frame(2, 2, 'car', null));
    draw();
    expect(bridge.placingActorIds).toEqual(['ego']);
    bridge.reset();
    expect(bridge.placingActorIds).toEqual([]);
    bridge.dispose();
  });

  it('stands a body without engine contact on the rendered road only once the road is indexed', () => {
    const viewer = headlessViewer() as unknown as { getGroundIndex: () => unknown; sampleGroundHeight: (x: number, z: number) => number | null };
    let indexed = false;
    viewer.getGroundIndex = () => (indexed ? { sample: () => 3.25, sampleNear: () => 3.25, bounds: () => ({ min: { x: 0, z: 0 }, max: { x: 1, z: 1 } }) } : null);
    viewer.sampleGroundHeight = () => null;
    const withoutLift = createTruthViewerBridge(viewer as unknown as CityViewer, { layer: 'no-lift', groundLift: false, now: () => 0 });
    const bridge = createTruthViewerBridge(viewer as unknown as CityViewer, { layer: 'lift', now: () => 0 });
    bridge.apply(frame(0, 0, 'car', null));
    expect(bridge.placingActorIds).toEqual(['ego']);
    indexed = true;
    bridge.apply(frame(1, 1, 'car', null));
    (viewer as unknown as CityViewer).onFrame?.(0.1);
    expect(bridge.rendered('ego')?.y).toBe(3.25);
    expect(bridge.placingActorIds).toEqual([]);

    // Lifting off: only the engine's contact places a body.
    withoutLift.apply(frame(0, 0, 'car', null));
    expect(withoutLift.rendered('ego')).toBeNull();
    expect(withoutLift.placingActorIds).toEqual(['ego']);
    bridge.dispose();
    withoutLift.dispose();
  });

  it('shows a stand-in only until the world produces its first frame', () => {
    const { bridge, sync } = bridgeWithSpy();
    const clear = vi.spyOn(bridge.actors, 'clearLayer');
    const spawn = { id: 'ego', catalogId: 'vehicle.sedan', x: 12, y: 0, z: -3, headingRad: 1, dims: { l: 4.5, w: 1.9, h: 1.5 }, kind: 'car' as const };

    // Drawn on its own layer, lifted like a frame's actors (no ground here: authored y).
    expect(bridge.standIn(spawn)).toMatchObject({ x: 12, y: 0, z: -3 });
    expect(sync.mock.calls.at(-1)?.[0]).toBe('test:stand-in');
    expect(sync.mock.calls.at(-1)?.[1][0]).toMatchObject({ id: 'ego', catalogId: 'vehicle.sedan', headingRad: 1 });

    // The world's first frame replaces it, and a later stand-in is refused.
    bridge.apply(frame(0, 0));
    expect(clear).toHaveBeenCalledWith('test:stand-in');
    expect(sync.mock.calls.at(-1)?.[0]).toBe('test');
    clear.mockClear();
    expect(bridge.standIn(spawn)).toBeNull();
    expect(sync.mock.calls.at(-1)?.[0]).toBe('test');

    // A rebuild restarts from no frame, so a stand-in may bridge the gap again.
    bridge.reset();
    expect(bridge.standIn(spawn)).not.toBeNull();
    bridge.standIn(null);
    expect(clear).toHaveBeenLastCalledWith('test:stand-in');
    bridge.dispose();
  });
});

/**
 * The drive's channel, reproduced: a worker wakes on a jittery interval, steps
 * the 20 ms world by however much wall time passed (the authored playback
 * budget, capped catch-up and all), and posts every step; the page draws at the
 * display's rate. The car cruises at 25 m/s, so every displayed frame should
 * move it by `25 * frameDt` — any freeze or leap is the jitter a driver sees.
 */
function simulateDrive(opts: {
  displayHz: number;
  workerHz: number;
  seconds: number;
  draw: (wallMs: number) => number;
  deliver: (frame: TruthFrame, wallMs: number) => void;
}): { wallMs: number; x: number }[] {
  const speed = 25;
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  let tick = 0;
  let remainder = 0;
  let lastWorkerWake = 0;
  let nextWorkerWake = 1000 / opts.workerHz;
  let nextDisplay = 0;
  const maxTicks = Math.max(1, Math.ceil(1.5 / opts.workerHz / 0.02));
  const drawn: { wallMs: number; x: number }[] = [];
  const cruise = (t: number): TruthFrame => {
    const base = frame(t, speed * t * 0.02);
    const actor = base.scene.actors[0] as unknown as { velocity: number[] };
    actor.velocity = [speed, 0, 0];
    return base;
  };
  opts.deliver(cruise(0), 0);
  for (let wall = 0; wall < opts.seconds * 1000; wall += 0.25) {
    if (wall >= nextWorkerWake) {
      const available = remainder + (wall - lastWorkerWake) / 1000;
      const steps = Math.min(Math.floor((available + 1e-12) / 0.02), maxTicks);
      remainder = Math.min(available - steps * 0.02, 0.02);
      lastWorkerWake = wall;
      // setInterval in a busy worker: late by up to 4 ms, never early.
      nextWorkerWake += 1000 / opts.workerHz + random() * 4 - 2;
      for (let k = 0; k < steps; k += 1) opts.deliver(cruise((tick += 1)), wall + 0.3);
    }
    if (wall >= nextDisplay) {
      drawn.push({ wallMs: wall, x: opts.draw(wall) });
      // A compositor that is mostly on time, with the odd late frame.
      nextDisplay += (1000 / opts.displayHz) * (random() < 0.03 ? 2 : 1);
    }
  }
  return drawn;
}

/** How far each displayed frame's motion departs from the car's real motion, as a fraction. */
function motionError(drawn: { wallMs: number; x: number }[], speed = 25): { worst: number; frozenFrames: number } {
  let worst = 0;
  let frozenFrames = 0;
  // Skip the first second: the clock is still learning the channel.
  const settled = drawn.filter((sample) => sample.wallMs > 1000);
  for (let index = 1; index < settled.length; index += 1) {
    const expected = speed * (settled[index]!.wallMs - settled[index - 1]!.wallMs) / 1000;
    const moved = settled[index]!.x - settled[index - 1]!.x;
    worst = Math.max(worst, Math.abs(moved - expected) / expected);
    if (moved < expected * 0.25) frozenFrames += 1;
  }
  return { worst, frozenFrames };
}

describe('truth viewer bridge at display rate', () => {
  for (const displayHz of [60, 120, 144]) {
    for (const workerHz of [50, 20]) {
      it(`draws a cruising car without freezes or leaps at ${displayHz} Hz over a ${workerHz} Hz worker`, () => {
        const { bridge, sync, viewer, wall } = bridgeWithSpy();
        const drawn = simulateDrive({
          displayHz,
          workerHz,
          seconds: 6,
          deliver: (next, wallMs) => {
            wall.ms = wallMs;
            bridge.apply(next);
          },
          draw: (wallMs) => {
            wall.ms = wallMs;
            viewer.onFrame?.(1 / displayHz);
            return sync.mock.calls.at(-1)![1].find((actor) => actor.id === 'ego')!.x;
          },
        });
        const { worst, frozenFrames } = motionError(drawn);
        expect(frozenFrames).toBe(0);
        // Rate trimming is at most 10 %, and only while the clock converges.
        expect(worst).toBeLessThan(0.12);
        bridge.dispose();
      });
    }
  }

  it('fails the same check the way the drive used to draw: the newest pair, blended from its arrival', () => {
    // The pre-fix bridge, reduced to its timing: on every arrival the blend
    // restarted from the previous newest step, over the steps' 20 ms spacing.
    let earlier: TruthFrame | null = null;
    let latest: TruthFrame | null = null;
    let arrivedAt = 0;
    const drawn = simulateDrive({
      displayHz: 60,
      workerHz: 20,
      seconds: 6,
      deliver: (next, wallMs) => {
        earlier = latest;
        latest = next;
        arrivedAt = wallMs;
      },
      draw: (wallMs) => {
        const to = latest!.scene.actors[0]!.position[0];
        if (!earlier) return to;
        const from = (earlier as TruthFrame).scene.actors[0]!.position[0];
        const alpha = Math.min(1, (wallMs - arrivedAt) / 1000 / (latest!.timeSec - (earlier as TruthFrame).timeSec));
        return from + (to - from) * alpha;
      },
    });
    const { worst, frozenFrames } = motionError(drawn);
    expect(frozenFrames).toBeGreaterThan(drawn.length * 0.2);
    expect(worst).toBeGreaterThan(0.9);
  });
});
