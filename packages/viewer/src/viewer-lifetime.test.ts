import { afterEach, expect, it, vi } from 'vitest';
import type * as Three from 'three';

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof Three>();
  const contexts = new WeakMap<object, { lost: boolean }>();
  return {
    ...three,
    WebGLRenderer: class {
      domElement: HTMLCanvasElement;
      debug = {};
      shadowMap = {};
      info = { programs: [], render: { calls: 0, triangles: 0 } };
      capabilities = { maxTextureSize: 4096 };
      private state: { lost: boolean };
      constructor({ canvas }: { canvas: HTMLCanvasElement }) {
        this.domElement = canvas;
        let state = contexts.get(canvas);
        if (!state) contexts.set(canvas, (state = { lost: false }));
        this.state = state;
      }
      getContext() {
        return { MAX_TEXTURE_SIZE: 0x0d33, getExtension: () => null,
          getParameter: (key: number) => key === 0x0d33 ? 4096 : 'test renderer',
          isContextLost: () => this.state.lost };
      }
      setPixelRatio() {}
      setSize() {}
      dispose() {}
      forceContextLoss() { this.state.lost = true; }
    },
  };
});
vi.mock('./camera-controls', () => ({ CameraRig: class { setPoseConstraint() {} dispose() {} } }));

import { CityViewer } from './viewer';
import { installViewerRuntimeDiagnostics } from './viewer-diagnostics';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('preserves a retained canvas across disposal and remount (Activity delay: %s)', async (delayed) => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    devicePixelRatio: 1, innerWidth: 800, innerHeight: 600, setTimeout, clearTimeout, setInterval, clearInterval,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const element = Object.assign(new EventTarget(), {
    isConnected: true, clientWidth: 800, clientHeight: 600, width: 800, height: 600,
    style: {}, getBoundingClientRect: () => ({ width: 800, height: 600 }),
  });
  const canvas = element as unknown as HTMLCanvasElement;
  const first = new CityViewer(canvas, { cinematicLighting: false });
  first.dispose();
  if (delayed) {
    await Promise.resolve();
    await Promise.resolve();
    expect(first.renderer.getContext().isContextLost()).toBe(false);
  }
  const successor = new CityViewer(canvas, { cinematicLighting: false });
  const diagnostics = installViewerRuntimeDiagnostics(successor);
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(successor.renderer.getContext().isContextLost()).toBe(false);
    expect(window.__simforgeViewerProbe?.viable).toBe(true);
    // Actual unmount must still release the last owner's context.
    element.isConnected = false;
    successor.dispose();
    await Promise.resolve();
    expect(() => new CityViewer(canvas, { cinematicLighting: false })).toThrow('create a new canvas');
    expect(successor.renderer.getContext().isContextLost()).toBe(true);
  } finally {
    diagnostics.dispose();
    successor.dispose();
  }
});
