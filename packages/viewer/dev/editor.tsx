/**
 * The editor surface, as a harness page: `CityView` mounted between React
 * panels, driven by `?mode=web|native|auto`.
 *
 * This exists so one Playwright flow can exercise the SAME editor
 * interactions against both backends. The component, the native adapter and
 * the contract adapter are the shipped ones; the only thing this file adds is
 * a window handle for a test to drive and read.
 *
 * The native backend runs in a different process from the page, exactly as it
 * does under Electron, so the port here forwards to the harness's Node side
 * through `window.__nativeCall` (Electron uses IPC through
 * `packages/studio-host/src/native-viewport-bridge.ts`; the shape is the
 * same). `window.__nativeEvent` is how that side pushes readiness and camera
 * reports back.
 *
 *   /editor.html?mode=native&manifest=<url>&mapVersionId=<id>&releaseDigest=<hex>
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CityView } from '../src/react';
import { ThreeRendererAdapter, cameraStateReport } from '../src/renderer-contract-adapter';
import type { NativeReadiness, NativeViewportPort, RendererMode } from '../src/native-renderer-adapter';
import type { CameraCommand, CameraStateReport, PickRequest, PickResult } from '../src/renderer-contract';
import type { CityViewer } from '../src/viewer';

type Vec3 = readonly [number, number, number];

declare global {
  interface Window {
    __nativeCall?: (method: string, payload: unknown) => Promise<unknown>;
    __nativeEvent?: (kind: string, payload: unknown) => void;
    __editor: {
      /** Which backend actually mounted, read off the component's own DOM. */
      renderer(): string | null;
      readiness(): string | null;
      nativeFallback(): string | null;
      /** True when a WebGL canvas is in the tree, whatever the mode asked for. */
      webCanvasPresent(): boolean;
      readinessLog(): string[];
      error(): string | null;
      /** Editor-side camera command, dispatched to whichever backend is live. */
      setPose(position: Vec3, target: Vec3): Promise<void>;
      cameraState(): CameraStateReport | null;
      resizeRegion(width: number, height: number): void;
      pick(x: number, y: number): Promise<PickResult>;
      nativeReadiness(): string | null;
      drawable(): boolean;
    };
  }
}

const params = new URLSearchParams(location.search);
const mode = (params.get('mode') ?? 'web') as RendererMode;
const manifestUrl = params.get('manifest');
const mapVersionId = params.get('mapVersionId') ?? undefined;
const releaseDigest = params.get('releaseDigest') ?? undefined;
if (!manifestUrl) throw new Error('?manifest=<url to 3d/manifest.json> is required');

// The KTX2 transcoder is served by the map server at `<map origin>/basis/`,
// not by vite. Left to its default it resolves against this page's origin,
// the dev server answers the 404 with index.html, and the viewer reports
// `Unexpected identifier 'html'` instead of loading a texture. Identical to
// what `main.ts` does, and stable so the options object never remounts the
// viewer.
const VIEWER_OPTIONS = {
  antialias: false,
  maxPixelRatio: 1,
  ktx2TranscoderPath: `${new URL(manifestUrl, location.href).origin}/basis/`,
};

/**
 * The out-of-process native viewport, as page script sees it. Every method
 * forwards; nothing is simulated. `cameraState` is synchronous in the
 * contract, so the last report pushed from the process is cached here — the
 * page never invents a pose.
 */
function createNativePort(): NativeViewportPort {
  const listeners = new Set<(state: NativeReadiness, detail?: string) => void>();
  let readiness: NativeReadiness = 'starting';
  let camera: CameraStateReport | null = null;
  const call = (method: string, payload: unknown): Promise<unknown> => {
    const bridge = window.__nativeCall;
    if (!bridge) return Promise.reject(new Error('native bridge is not installed'));
    return bridge(method, payload);
  };
  window.__nativeEvent = (kind, payload) => {
    if (kind === 'readiness') {
      const { state, detail } = payload as { state: NativeReadiness; detail?: string };
      readiness = state;
      for (const listener of listeners) listener(state, detail);
      return;
    }
    if (kind === 'camera-state') camera = payload as CameraStateReport;
  };
  return {
    implementation: 'bevy-native',
    mode: 'native',
    get readiness() { return readiness; },
    async loadMap(input) { await call('loadMap', input); },
    resize(input) { void call('resize', input); },
    setSelection(ids) { void call('setSelection', { ids: [...ids] }); },
    applyCamera(command) { void call('applyCamera', command); },
    cameraState() { return camera; },
    async pick(request) { return (await call('pick', request)) as PickResult; },
    onReadiness(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() { await call('dispose', {}); },
  };
}

const nativePort = mode === 'web' ? undefined : createNativePort();

function Editor(): React.ReactElement {
  const [readinessLog, setReadinessLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const viewerRef = useRef<CityViewer | null>(null);
  const webAdapterRef = useRef<ThreeRendererAdapter | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const onReady = useCallback((viewer: CityViewer) => {
    viewerRef.current = viewer;
    // The same adapter the scenario editor drives the WebGL backend through.
    webAdapterRef.current = new ThreeRendererAdapter(viewer);
    viewer.setCameraPoseConstraintsEnabled(false);
  }, []);

  useEffect(() => {
    window.__editor = {
      renderer: () => document.querySelector('[data-renderer]')?.getAttribute('data-renderer') ?? null,
      readiness: () => document.querySelector('[data-readiness]')?.getAttribute('data-readiness') ?? null,
      nativeFallback: () => document.querySelector('[data-native-fallback]')?.getAttribute('data-native-fallback') ?? null,
      webCanvasPresent: () => document.querySelector('canvas[data-renderer]') !== null,
      readinessLog: () => readinessLog,
      error: () => error,
      // The port's own readiness, not React state: a test that waits on
      // `drawable()` alone waits out its timeout when the backend failed.
      nativeReadiness: () => nativePort?.readiness ?? null,
      drawable: () => {
        if (nativePort && document.querySelector('[data-renderer="native"]')) {
          return nativePort.readiness === 'interactive' || nativePort.readiness === 'complete';
        }
        return mapLoaded;
      },
      setPose: async (position, target) => {
        const command: CameraCommand = { kind: 'set-pose', pose: { position, target } };
        const native = document.querySelector('[data-renderer="native"]');
        if (native && nativePort) {
          nativePort.applyCamera(command);
          return;
        }
        const adapter = webAdapterRef.current;
        if (!adapter) throw new Error('web renderer is not ready');
        adapter.applyCameraCommand(command);
      },
      cameraState: () => {
        const native = document.querySelector('[data-renderer="native"]');
        if (native && nativePort) return nativePort.cameraState();
        const viewer = viewerRef.current;
        return viewer ? cameraStateReport(viewer) : null;
      },
      resizeRegion: (width, height) => setSize({ width, height }),
      pick: async (x, y) => {
        const request: PickRequest = { ndc: { x, y }, layers: ['map-static', 'ground', 'actors'], maxHits: 8 };
        const native = document.querySelector('[data-renderer="native"]');
        if (native && nativePort) return nativePort.pick(request);
        const adapter = webAdapterRef.current;
        if (!adapter) throw new Error('web renderer is not ready');
        return adapter.pick(request);
      },
    };
  }, [error, mapLoaded, readinessLog]);

  const viewportStyle = size.width > 0
    ? { width: `${size.width}px`, height: `${size.height}px` }
    : { width: '100%', height: '100%' };

  return (
    <div id="shell-inner" style={{ display: 'grid', gridTemplateColumns: '220px 1fr 220px', height: '100vh' }}>
      <div className="panel" data-panel="layers">
        <strong>Layers</strong>
        <div>map-static</div>
        <div>ground</div>
        <div>actors</div>
      </div>
      <div id="viewport" style={{ position: 'relative' }}>
        <CityView
          manifestUrl={manifestUrl}
          initialOptions={VIEWER_OPTIONS}
          rendererMode={mode}
          nativeViewport={nativePort}
          nativeMapVersionId={mapVersionId}
          nativeReleaseDigest={releaseDigest}
          nativeScreenOffset={{ x: 0, y: 0 }}
          ariaLabel="map viewport"
          style={viewportStyle}
          onReady={onReady}
          onMapLoaded={() => setMapLoaded(true)}
          onError={(reason) => setError(reason instanceof Error ? reason.message : String(reason))}
          onNativeReadiness={(state, detail) => {
            setReadinessLog((log) => [...log, detail ? `${state}:${detail}` : state]);
          }}
        />
      </div>
      <div className="panel" data-panel="inspector">
        <strong>Inspector</strong>
        <div data-field="mode">{mode}</div>
        <div data-field="error">{error ?? '-'}</div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('shell')!).render(<Editor />);
