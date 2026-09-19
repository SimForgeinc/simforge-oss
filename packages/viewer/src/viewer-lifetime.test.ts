import { afterEach, expect, it, vi } from 'vitest';
import type * as Three from 'three';
import { Box3, Group, Scene, Vector3 } from 'three';
import { TileStreamLayer } from './streaming';

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof Three>();
  const contexts = new WeakMap<object, { lost: boolean }>();
  return {
    ...three,
    WebGLRenderer: class {
      domElement: HTMLCanvasElement;
      debug = {};
      shadowMap = {};
      info = { programs: [], render: { calls: 0, triangles: 0 }, reset: vi.fn() };
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
      render = vi.fn();
      dispose() {}
      forceContextLoss() { this.state.lost = true; }
    },
  };
});
vi.mock('./camera-controls', () => ({ CameraRig: class { setPoseConstraint() {} update() {} dispose() {} } }));

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

function contractViewer(options: ConstructorParameters<typeof CityViewer>[1] = {}) {
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    devicePixelRatio: 1, innerWidth: 800, innerHeight: 600, setTimeout, clearTimeout, setInterval, clearInterval,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  const canvas = Object.assign(new EventTarget(), {
    isConnected: true, clientWidth: 800, clientHeight: 600, style: {},
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
  }) as unknown as HTMLCanvasElement;
  return new CityViewer(canvas, options);
}

it.each([
  { sunIntensity: 0 }, { exposure: NaN }, { environmentIntensity: 0 },
])('refuses degenerate construction: %j', (options) => {
  expect(() => contractViewer(options)).toThrowError(expect.objectContaining({ name: 'ViewerInputError' }));
});

it('refuses a blank map reference before fetching', async () => {
  const viewer = contractViewer();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
    await expect(viewer.loadMap(' ')).rejects.toMatchObject({ name: 'ViewerInputError', field: 'map' });
    expect(fetcher).not.toHaveBeenCalled();
    const frame = vi.mocked(requestAnimationFrame).mock.calls[0]![0];
    frame(performance.now());
    expect(viewer.renderer.render).not.toHaveBeenCalled();
    expect(viewer.getStats().usable).toBe(false);
  } finally { viewer.dispose(); }
});

it('refuses a manifest with no renderable city or road members', async () => {
  const viewer = contractViewer();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    scene: { bounds: { min: [0, 0, 0], max: [10, 10, 10] } }, tiles: [],
  }))));
  try {
    await expect(viewer.loadMap('/empty.json')).rejects.toMatchObject({ name: 'ViewerInputError', field: 'map.members' });
    expect(viewer.getStats().usable).toBe(false);
  } finally { viewer.dispose(); }
});

it('rejects invalid live exposure without changing the applied exposure', () => {
  const viewer = contractViewer();
  try {
    expect(() => viewer.setExposure(0)).toThrowError(expect.objectContaining({ name: 'ViewerInputError' }));
    expect(viewer.renderer.toneMappingExposure).toBe(1);
    expect(() => viewer.setLiveQuality({ exposure: NaN })).toThrowError(expect.objectContaining({ name: 'ViewerInputError' }));
  } finally { viewer.dispose(); }
});

it('reports missing lighting and tier defaults separately from explicit input', () => {
  const viewer = contractViewer({ sunIntensity: undefined });
  try {
    expect(viewer.getRenderConfiguration()).toMatchObject({
      sunIntensity: 5, environmentIntensity: 0.6, exposure: 1,
      mapTextureTier: 'medium',
      defaulted: expect.arrayContaining(['sunIntensity', 'environmentIntensity', 'exposure', 'mapTextureTier']),
    });
  } finally { viewer.dispose(); }
});

it('enforces the resident budget on a frame without waiting for another admission', async () => {
  const viewer = contractViewer({ byteBudget: 10, cinematicLighting: false });
  let wanted = true;
  const layer = new TileStreamLayer({
    name: 'budget-pressure', renderer: { compileAsync: async () => undefined } as never, scene: new Scene(),
    defs: [{ id: 'offscreen', box: new Box3(new Vector3(), new Vector3(1, 1, 1)),
      lods: [{ level: 0, file: 'tile.glb', triangles: 1, fileSize: 1, geometricError: 0 }] }],
    build: async () => ({ object: new Group(), resources: { geometries: [], materials: [], textures: [] },
      bytes: 20, pendingTextures: [] }),
    maxConcurrent: 1, pinCoarsest: true, want: () => wanted,
    memory: { admit: () => true, maxAssetBytes: () => 100 },
  });
  Object.assign(viewer, { cityLayer: layer, lastStreamUpdate: -Infinity });
  try {
    layer.update(new Vector3(), 1, 9999);
    await Promise.resolve();
    layer.pumpUploads(performance.now() + 100, { remaining: 1 }, viewer.camera);
    await layer.whenCompilationIdle();
    expect(viewer.getStats().residentBytes).toBe(20);
    wanted = false;
    vi.mocked(requestAnimationFrame).mock.calls[0]![0](performance.now());
    expect(viewer.getStats().residentBytes).toBeLessThanOrEqual(10);
    expect(layer.group.children).toHaveLength(0);
  } finally { viewer.dispose(); }
});
