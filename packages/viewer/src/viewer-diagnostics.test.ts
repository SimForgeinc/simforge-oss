import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityViewer } from './viewer';
import { installViewerRuntimeDiagnostics } from './viewer-diagnostics';

const disposals: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    setTimeout, clearTimeout, setInterval, clearInterval, innerWidth: 800, innerHeight: 600,
  }));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  let lost = false;
  const canvas = Object.assign(new EventTarget(), {
    isConnected: true, width: 800, height: 600,
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
    expect(first.probe.readyAtMs).not.toBeNull();
    const second = mount();
    first.diagnostics.dispose();
    first.canvas.isConnected = false;
    first.loseContext();
    first.diagnostics.mapLoadSucceeded('/first/manifest.json');
    second.diagnostics.mapLoadStarted('/second/manifest.json');
    second.diagnostics.mapLoadSucceeded('/second/manifest.json');
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
    expect(mounted.probe.readyAtMs).not.toBeNull();
    mounted.loseContext();
    expect(mounted.probe.viable).toBe(false);
    expect(mounted.probe.readyAtMs).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[viewer-diagnostics]', 'webglcontextlost', expect.objectContaining({ manifestUrl: '/map/manifest.json' }));
  });
});
