import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { CityViewer } from './viewer';
import type { CityViewerOptions } from './types';
import type { NativeReadiness, NativeViewportPort } from './native-renderer-adapter';
import { installViewerRuntimeDiagnostics, type ViewerRuntimeDiagnostics } from './viewer-diagnostics';
export { waitForCanvasPresentation } from './canvas-presentation';

export interface CityViewProps {
  manifestUrl: string;
  rendererMode?: 'web' | 'native' | 'auto';
  nativeViewport?: NativeViewportPort;
  /** Immutable map version id; required for the native backend. */
  nativeMapVersionId?: string;
  /** Release digest of that map version; required for the native backend. */
  nativeReleaseDigest?: string;
  /**
   * Screen-space offset of the page's client area, from the desktop shell.
   * The native surface is an OS window positioned over this component, so it
   * needs page coordinates translated into screen coordinates.
   */
  nativeScreenOffset?: { x: number; y: number };
  /** Constructor settings, sampled once per mounted view. Use viewer setters for live changes, or a new React key to recreate it. */
  initialOptions?: CityViewerOptions;
  className?: string;
  style?: CSSProperties;
  onReady?: (viewer: CityViewer) => void;
  /** Terminal release only, including cache eviction/unmount; clear held state, do not use the released viewer. */
  onDisposed?: (viewer: CityViewer) => void;
  onMapLoaded?: (manifestUrl: string) => void;
  onError?: (error: unknown, manifestUrl: string) => void;
  onCapabilitiesChange?: (capabilities: readonly string[]) => void;
  /** Every native readiness transition, for UI that shows load progress. */
  onNativeReadiness?: (state: NativeReadiness, detail?: string) => void;
  ariaLabel?: string;
  role?: string;
  tabIndex?: number;
}

const CANVAS_STYLE: CSSProperties = { display: 'block', width: '100%', height: '100%' };
let heldCityView: { viewer: CityViewer; release: () => void } | null = null;

export function CityView({
  manifestUrl,
  rendererMode = 'web',
  nativeViewport,
  nativeMapVersionId,
  nativeReleaseDigest,
  nativeScreenOffset,
  initialOptions,
  className,
  style,
  onReady,
  onDisposed,
  onMapLoaded,
  onError,
  onCapabilitiesChange,
  onNativeReadiness,
  ariaLabel,
  role,
  tabIndex,
}: CityViewProps): ReactElement {
  const nativeRequested = rendererMode === 'native';
  const nativeConfigured = nativeViewport !== undefined && Boolean(nativeMapVersionId && nativeReleaseDigest);
  /**
   * `auto` gives up on the native backend for good once it fails, so the
   * WebGL canvas mounts in its place without a page reload. Explicit `native`
   * never falls back: a mode the user asked for by name has to report its own
   * failure, or "native" silently means "whatever worked".
   */
  const [nativeFailed, setNativeFailed] = useState(false);
  const useNative = nativeRequested || (rendererMode === 'auto' && nativeConfigured && !nativeFailed);
  const nativeUnavailable = nativeRequested && !nativeConfigured;
  const [nativeReadiness, setNativeReadiness] = useState<NativeReadiness | null>(null);
  const [nativeDetail, setNativeDetail] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadedManifest, setLoadedManifest] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nativeRegionRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CityViewer | null>(null);
  const diagnosticsRef = useRef<ViewerRuntimeDiagnostics | null>(null);
  const retainedObserverRef = useRef<MutationObserver | null>(null);
  const mapLoadRef = useRef<{ viewer: CityViewer; url: string; promise: Promise<void> } | null>(null);
  const generationRef = useRef(0);
  const initialOptionsRef = useRef(initialOptions);
  const onReadyRef = useRef(onReady);
  const onDisposedRef = useRef(onDisposed);
  const onErrorRef = useRef(onError);
  const onMapLoadedRef = useRef(onMapLoaded);
  const onCapabilitiesRef = useRef(onCapabilitiesChange);
  const onNativeReadinessRef = useRef(onNativeReadiness);
  const manifestRef = useRef(manifestUrl);
  onReadyRef.current = onReady;
  onDisposedRef.current = onDisposed;
  onErrorRef.current = onError;
  onMapLoadedRef.current = onMapLoaded;
  onCapabilitiesRef.current = onCapabilitiesChange;
  onNativeReadinessRef.current = onNativeReadiness;
  manifestRef.current = manifestUrl;

  useLayoutEffect(() => {
    if (useNative || !canvasRef.current) return;
    const canvas = canvasRef.current;
    retainedObserverRef.current?.disconnect();
    retainedObserverRef.current = null;
    if (heldCityView?.viewer === viewerRef.current) heldCityView = null;
    else heldCityView?.release();
    const viewer = viewerRef.current ?? new CityViewer(canvas, initialOptionsRef.current);
    viewer.setActivityHeld(false);
    const diagnostics = installViewerRuntimeDiagnostics(viewer);
    diagnosticsRef.current = diagnostics;
    viewerRef.current = viewer;
    const onContextLost = () => {
      const failure = new Error('WebGL context was lost; reload the map to recreate its GPU resources');
      setError(failure);
      onErrorRef.current?.(failure, manifestRef.current);
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    onReadyRef.current?.(viewer);
    return () => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      diagnostics.dispose();
      if (diagnosticsRef.current === diagnostics) diagnosticsRef.current = null;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        retainedObserverRef.current?.disconnect();
        retainedObserverRef.current = null;
        if (heldCityView?.viewer === viewer) heldCityView = null;
        if (viewerRef.current === viewer) {
          viewerRef.current = null;
          mapLoadRef.current = null;
          setLoadedManifest(null);
        }
        onDisposedRef.current?.(viewer);
        viewer.dispose();
      };
      if (canvas.isConnected && !viewer.renderer.getContext().isContextLost()) {
        // Activity hides a connected tree before its layout-effect cleanup.
        // Its parent state still refers to this viewer: retain the whole owner,
        // not just its GL context, and stop its RAF while it is hidden.
        viewer.setActivityHeld(true);
        heldCityView?.release();
        heldCityView = { viewer, release };
        const observer = new MutationObserver(() => {
          if (retainedObserverRef.current === observer && !canvas.isConnected) release();
        });
        retainedObserverRef.current = observer;
        observer.observe(canvas.ownerDocument.documentElement, { childList: true, subtree: true });
      } else release();
    };
  }, [useNative]);

  useEffect(() => {
    if (!useNative || !nativeViewport || !nativeMapVersionId || !nativeReleaseDigest) return;
    setNativeReadiness('starting');
    setNativeDetail(null);
    let disposed = false;
    const unsubscribe = nativeViewport.onReadiness((state, detail) => {
      if (disposed) return;
      setNativeReadiness(state);
      setNativeDetail(detail ?? null);
      onNativeReadinessRef.current?.(state, detail);
      if (state === 'interactive') onMapLoadedRef.current?.(manifestRef.current);
      if (state !== 'error' && state !== 'device-lost') return;
      const failure = new Error(detail ?? `Native viewport ${state}`);
      if (rendererMode === 'auto') {
        // Dispose first: the native window has to be gone before the WebGL
        // canvas takes over the region, or two renderers fight over it.
        void nativeViewport.dispose().finally(() => {
          if (!disposed) setNativeFailed(true);
        });
        return;
      }
      setError(failure);
      onErrorRef.current?.(failure, manifestRef.current);
    });
    nativeViewport.loadMap({ mapVersionId: nativeMapVersionId, releaseDigest: nativeReleaseDigest }).catch((reason: unknown) => {
      if (disposed) return;
      setNativeReadiness('error');
      setNativeDetail(reason instanceof Error ? reason.message : String(reason));
      if (rendererMode === 'auto') {
        setNativeFailed(true);
        return;
      }
      onErrorRef.current?.(reason, manifestRef.current);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [manifestUrl, nativeViewport, nativeMapVersionId, nativeReleaseDigest, rendererMode, useNative]);

  /**
   * Keep the native OS window over this component's rectangle.
   *
   * This is option (a) from `renderer/viewport/PROTOCOL.md`: a native child
   * window clipped to the editor's viewport region, which keeps the GPU
   * surface under the renderer's own control instead of paying a per-frame
   * copy to composite into a DOM canvas.
   */
  const syncNativeRegion = useCallback(() => {
    const region = nativeRegionRef.current;
    if (!region || !nativeViewport) return;
    const rect = region.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const offset = nativeScreenOffset ?? { x: typeof window === 'undefined' ? 0 : window.screenX, y: typeof window === 'undefined' ? 0 : window.screenY };
    nativeViewport.resize({
      width: rect.width,
      height: rect.height,
      pixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
      x: Math.round(offset.x + rect.left),
      y: Math.round(offset.y + rect.top),
    });
  }, [nativeScreenOffset, nativeViewport]);

  useEffect(() => {
    if (!useNative || !nativeViewport || nativeReadiness === null) return;
    syncNativeRegion();
    const region = nativeRegionRef.current;
    const observer = region && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncNativeRegion) : null;
    if (region) observer?.observe(region);
    window.addEventListener('resize', syncNativeRegion);
    window.addEventListener('scroll', syncNativeRegion, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncNativeRegion);
      window.removeEventListener('scroll', syncNativeRegion, true);
    };
  }, [nativeReadiness, nativeViewport, syncNativeRegion, useNative]);

  useEffect(() => {
    if (useNative) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const generation = ++generationRef.current;
    setError(null);
    onCapabilitiesRef.current?.([]);
    diagnosticsRef.current?.mapLoadStarted(manifestUrl);
    let load = mapLoadRef.current;
    if (!load || load.viewer !== viewer || load.url !== manifestUrl) {
      const promise = viewer.loadMap(manifestUrl);
      load = { viewer, url: manifestUrl, promise };
      mapLoadRef.current = load;
      void promise.catch(() => { if (mapLoadRef.current?.promise === promise) mapLoadRef.current = null; });
    }
    load.promise.then(() => {
      if (generation !== generationRef.current) return;
      setLoadedManifest(manifestUrl);
      diagnosticsRef.current?.mapLoadSucceeded(manifestUrl);
      onMapLoadedRef.current?.(manifestUrl);
      onCapabilitiesRef.current?.(viewer.getCapabilities());
    }).catch((reason: unknown) => {
      if (generation !== generationRef.current) return;
      setLoadedManifest(null);
      setError(reason);
      onErrorRef.current?.(reason, manifestUrl);
    });
    // Disposed loads may resolve after abort; neither completion nor failure
    // belongs to a replacement renderer/map (including StrictMode remounts).
    return () => { generationRef.current++; };
  }, [manifestUrl, useNative]);

  if (useNative) {
    const readiness = nativeUnavailable ? 'error' : (nativeReadiness ?? 'starting');
    const settled = readiness === 'interactive' || readiness === 'complete';
    // The region is transparent and empty on purpose: the pixels come from
    // the native window positioned over it. The overlay is the load/failure
    // story the user needs while that window has nothing to show.
    return (
      <div
        ref={nativeRegionRef}
        aria-label={ariaLabel}
        className={className}
        role={role}
        tabIndex={tabIndex}
        style={{ ...CANVAS_STYLE, ...style, position: 'relative' }}
        data-renderer="native"
        data-readiness={readiness}
        data-native-fallback={rendererMode === 'auto' ? 'webgl' : 'none'}
      >
        {settled ? null : (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
            {readiness === 'error' || readiness === 'device-lost'
              ? `Native renderer ${readiness}${nativeDetail ? `: ${nativeDetail}` : ''}`
              : `Native renderer: ${readiness}`}
          </div>
        )}
      </div>
    );
  }
  return (
    <canvas
      ref={canvasRef}
      aria-label={ariaLabel}
      className={className}
      role={role}
      style={{ ...CANVAS_STYLE, ...style, visibility: loadedManifest === manifestUrl ? style?.visibility : 'hidden' }}
      tabIndex={tabIndex}
      data-renderer={nativeFailed ? 'web-after-native-fallback' : 'web'}
      data-error={error ? String(error) : undefined}
    />
  );
}
