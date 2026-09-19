import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityViewer } from './viewer';
import { installViewerRuntimeDiagnostics } from './viewer-diagnostics';

const disposals: Array<() => void> = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
function paintFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
}
function present() { paintFrame(); paintFrame(); }

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    setTimeout, clearTimeout, setInterval, clearInterval, innerWidth: 800, innerHeight: 600,
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('getComputedStyle', (element: { style: object }) => element.style);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  frames.clear();
});

function mount() {
  let lost = false;
  const canvas = Object.assign(new EventTarget(), {
    isConnected: true, width: 800, height: 600,
    style: { opacity: '1', display: 'block', visibility: 'visible' },
    parentElement: null,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
  });
  // Only the public diagnostics surface is relevant; no renderer internals mocked.
  const viewer = {
    renderer: { domElement: canvas, getContext: () => ({ isContextLost: () => lost }) },
    getRendererCapability: () => ({}),
    getStats: () => ({ targetQualityReady: true, residentBytes: 0, pendingBytes: 0, byteBudget: 100 }),
  } as unknown as CityViewer;
  const diagnostics = installViewerRuntimeDiagnostics(viewer);
  disposals.push(() => diagnostics.dispose());
  return { diagnostics, probe: window.__simforgeViewerProbe!, canvas,
    loseContext: () => { lost = true; canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); } };
}

describe('viewer probe lifetime', () => {
  it('invalidates a discarded StrictMode mount and ignores its late load completion without clearing the second mount', () => {
    const first = mount();
    first.diagnostics.mapLoadStarted('/first/manifest.json');
    first.diagnostics.mapLoadSucceeded('/first/manifest.json');
    present();
    expect(first.probe.readyAtMs).not.toBeNull();
    const second = mount();
    first.diagnostics.dispose();
    first.canvas.isConnected = false;
    first.loseContext();
    first.diagnostics.mapLoadSucceeded('/first/manifest.json');
    second.diagnostics.mapLoadStarted('/second/manifest.json');
    second.diagnostics.mapLoadSucceeded('/second/manifest.json');
    present();
    expect(first.probe.viable).toBe(false);
    expect(first.probe.readyAtMs).toBeNull();
    expect(window.__simforgeViewerProbe).toBe(second.probe);
    expect(second.probe.viable).toBe(true);
    expect(second.probe.readyAtMs).not.toBeNull();
  });

  it('invalidates readiness and reports context loss on a connected renderer that was already ready', () => {
    const mounted = mount();
    mounted.diagnostics.mapLoadStarted('/map/manifest.json');
    mounted.diagnostics.mapLoadSucceeded('/map/manifest.json');
    present();
    expect(mounted.probe.readyAtMs).not.toBeNull();
    mounted.loseContext();
    expect(mounted.probe.viable).toBe(false);
    expect(mounted.probe.readyAtMs).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[viewer-diagnostics]', 'webglcontextlost', expect.objectContaining({ manifestUrl: '/map/manifest.json' }));
  });

  it('withholds readiness until a visible paint, and cancels a replaced map waiting behind its cover', () => {
    const mounted = mount();
    mounted.canvas.style.opacity = '0';
    mounted.diagnostics.mapLoadStarted('/first');
    mounted.diagnostics.mapLoadSucceeded('/first');
    present();
    expect(mounted.probe.readyAtMs).toBeNull();
    mounted.canvas.style.opacity = '1';
    paintFrame();
    expect(mounted.probe.readyAtMs).toBeNull();
    mounted.diagnostics.mapLoadStarted('/second');
    present();
    expect(mounted.probe.readyAtMs).toBeNull();
    mounted.diagnostics.mapLoadSucceeded('/second');
    paintFrame();
    expect(mounted.probe.readyAtMs).toBeNull();
    paintFrame();
    expect(mounted.probe.readyAtMs).not.toBeNull();
    mounted.canvas.style.opacity = '0';
    expect(mounted.probe.readyAtMs).toBeNull();
  });
});
