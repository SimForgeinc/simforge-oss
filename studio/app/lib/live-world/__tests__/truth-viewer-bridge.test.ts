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

function frame(tick: number, x: number, actorClass: 'car' | 'truck' = 'car'): TruthFrame {
  return {
    tick,
    timeSec: tick * 0.02,
    signals: [],
    actors: [{ id: 'ego', class: actorClass, dims: { l: 4.5, w: 1.9, h: 1.5 }, accel: { ax: 0, ay: 0 } }],
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
  const bridge = createTruthViewerBridge(viewer, { layer: 'test', ...options });
  const sync = vi.spyOn(bridge.actors, 'syncLayer');
  /**
   * x as shown once the interpolation window has elapsed: the viewer's frame
   * hook is driven with a large dt so the display settles on the latest frame.
   */
  const renderedX = () => {
    viewer.onFrame?.(10);
    const call = sync.mock.calls.at(-1);
    return call ? call[1].find((actor) => actor.id === 'ego')?.x ?? null : null;
  };
  const renderedCatalog = () => sync.mock.calls.at(-1)?.[1].find((actor) => actor.id === 'ego')?.catalogId ?? null;
  return { bridge, sync, renderedX, renderedCatalog };
}

describe('truth viewer bridge', () => {
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
});
