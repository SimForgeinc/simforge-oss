import { describe, expect, it, vi } from 'vitest';
import type { NativeViewportBridge } from './desktop-map-cache';
import { nativeViewportProcessPort } from './native-viewport-bridge';

function bridgeDouble(overrides: Partial<NativeViewportBridge> = {}): NativeViewportBridge {
  return {
    profile: vi.fn(async () => { throw new Error('not used'); }),
    loadMap: vi.fn(async () => ({ ok: true as const })),
    start: vi.fn(async () => ({ ok: true as const })),
    camera: vi.fn(async () => ({ ok: true as const })),
    command: vi.fn(async () => ({ ok: true as const })),
    stop: vi.fn(async () => ({ ok: true as const })),
    onEvent: vi.fn(() => () => {}),
    ...overrides,
  } as NativeViewportBridge;
}

describe('native viewport process adapter', () => {
  it('forwards a valid camera command', async () => {
    const bridge = bridgeDouble();
    nativeViewportProcessPort(bridge).send({ command: 'camera', position: [1, 2, 3], target: [0, 0, 0] });
    await Promise.resolve();
    expect(bridge.camera).toHaveBeenCalledWith([1, 2, 3], [0, 0, 0]);
  });

  it('reports malformed camera vectors', async () => {
    const onError = vi.fn();
    const bridge = bridgeDouble();
    nativeViewportProcessPort(bridge, onError).send({ command: 'camera', position: [1], target: [0, 0, 0] });
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();
    expect(bridge.camera).not.toHaveBeenCalled();
  });

  it('routes rejected IPC to the error callback', async () => {
    const onError = vi.fn();
    const bridge = bridgeDouble({ camera: vi.fn(async () => { throw new Error('rejected'); }) });
    nativeViewportProcessPort(bridge, onError).send({ command: 'camera', position: [1, 2, 3], target: [0, 0, 0] });
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();
  });

  it('sends load-map as identity, never as a path', async () => {
    const bridge = bridgeDouble();
    nativeViewportProcessPort(bridge).send({
      command: 'load-map',
      mapRoot: '/should/not/travel',
      mapVersionId: 'usmap_1',
      releaseDigest: 'a'.repeat(64),
    });
    await Promise.resolve();
    expect(bridge.loadMap).toHaveBeenCalledWith({ mapVersionId: 'usmap_1', releaseDigest: 'a'.repeat(64) });
  });

  it('rejects load-map without identity', async () => {
    const onError = vi.fn();
    const bridge = bridgeDouble();
    nativeViewportProcessPort(bridge, onError).send({ command: 'load-map', mapVersionId: 'usmap_1' });
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();
    expect(bridge.loadMap).not.toHaveBeenCalled();
  });

  /**
   * The regression that broke picking end to end: every command the adapter
   * did not name explicitly was turned into a rejected promise, so a
   * `pointer-ray` never reached the renderer and the pick promise never
   * settled. Commands the adapter does not special-case must be forwarded.
   */
  it('forwards protocol commands it does not special-case', async () => {
    const onError = vi.fn();
    const bridge = bridgeDouble();
    const port = nativeViewportProcessPort(bridge, onError);
    const ray = { command: 'pointer-ray', origin: [0, 10, 0], direction: [0, -1, 0], layers: ['ground'], maxHits: 4 };
    port.send(ray);
    port.send({ command: 'resize', width: 800, height: 600, pixelRatio: 2 });
    port.send({ command: 'selection', ids: ['map-static:7:Post'] });
    await Promise.resolve();
    expect(bridge.command).toHaveBeenCalledWith(ray);
    expect(bridge.command).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it('passes viewport events through without dropping fields', () => {
    type Listener = Parameters<NativeViewportBridge['onEvent']>[0];
    const listeners: Listener[] = [];
    const bridge = bridgeDouble({
      onEvent: vi.fn((listener: Listener) => {
        listeners.push(listener);
        return () => {};
      }),
    });
    const seen: Record<string, unknown>[] = [];
    nativeViewportProcessPort(bridge).onEvent((event) => seen.push(event));
    // `hits` used to be projected away here, so a pick that did hit geometry
    // arrived at the renderer as an empty result.
    const [deliver] = listeners;
    if (!deliver) throw new Error('adapter did not subscribe to viewport events');
    deliver({
      event: 'picked',
      hits: [{ layer: 'map-static', id: 'map-static:7:Post', distanceM: 12.5, point: [1, 2, 3] }],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.hits).toEqual([{ layer: 'map-static', id: 'map-static:7:Post', distanceM: 12.5, point: [1, 2, 3] }]);
  });
});
