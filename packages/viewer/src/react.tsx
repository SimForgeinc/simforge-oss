import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { CityViewer } from './viewer';
import type { CityViewerOptions } from './types';
import type { NativeReadiness, NativeViewportPort } from './native-renderer-adapter';
import { installViewerRuntimeDiagnostics, type ViewerRuntimeDiagnostics } from './viewer-diagnostics';

export interface CityViewProps {
  manifestUrl: string;
  rendererMode?: 'web' | 'native' | 'auto';
  nativeViewport?: NativeViewportPort;
  nativeMapRoot?: string;
  nativeMapVersionId?: string;
  nativeReleaseDigest?: string;
  options?: CityViewerOptions;
  className?: string;
  style?: CSSProperties;
  onReady?: (viewer: CityViewer) => void;
  onMapLoaded?: (manifestUrl: string) => void;
  onError?: (error: unknown, manifestUrl: string) => void;
  onCapabilitiesChange?: (capabilities: readonly string[]) => void;
  ariaLabel?: string;
  role?: string;
  tabIndex?: number;
}

const CANVAS_STYLE: CSSProperties = { display: 'block', width: '100%', height: '100%' };

export function CityView({
  manifestUrl,
  rendererMode = 'web',
  nativeViewport,
  nativeMapRoot,
  nativeMapVersionId,
  nativeReleaseDigest,
  options,
  className,
  style,
  onReady,
  onMapLoaded,
  onError,
  onCapabilitiesChange,
  ariaLabel,
  role,
  tabIndex,
}: CityViewProps): ReactElement {
  const nativeRequested = rendererMode === 'native';
  const nativeConfigured = nativeViewport !== undefined && Boolean(nativeMapRoot && nativeMapVersionId && nativeReleaseDigest);
  const useNative = nativeRequested || (rendererMode === 'auto' && nativeConfigured);
  const nativeUnavailable = nativeRequested && !nativeConfigured;
  const [nativeReadiness, setNativeReadiness] = useState<NativeReadiness | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<CityViewer | null>(null);
  const diagnosticsRef = useRef<ViewerRuntimeDiagnostics | null>(null);
  const generationRef = useRef(0);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onMapLoadedRef = useRef(onMapLoaded);
  const onCapabilitiesRef = useRef(onCapabilitiesChange);
  const manifestRef = useRef(manifestUrl);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  onMapLoadedRef.current = onMapLoaded;
  onCapabilitiesRef.current = onCapabilitiesChange;
  manifestRef.current = manifestUrl;

  useEffect(() => {
    if (useNative || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const viewer = new CityViewer(canvas, options);
    diagnosticsRef.current = installViewerRuntimeDiagnostics(viewer);
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
      diagnosticsRef.current?.dispose();
      diagnosticsRef.current = null;
      viewerRef.current = null;
      viewer.dispose();
    };
  }, [options, useNative]);

  useEffect(() => {
    if (!useNative || !nativeConfigured || !nativeViewport || !nativeMapRoot || !nativeMapVersionId || !nativeReleaseDigest) return;
    setNativeReadiness('starting');
    const unsubscribe = nativeViewport.onReadiness((state, detail) => {
      setNativeReadiness(state);
      if (state === 'interactive') onMapLoadedRef.current?.(manifestRef.current);
      if (state === 'error' || state === 'device-lost') onErrorRef.current?.(new Error(detail ?? `Native viewport ${state}`), manifestRef.current);
    });
    nativeViewport.loadMap({ mapRoot: nativeMapRoot, mapVersionId: nativeMapVersionId, releaseDigest: nativeReleaseDigest }).catch((reason: unknown) => {
      setNativeReadiness('error');
      onErrorRef.current?.(reason, manifestRef.current);
    });
    return unsubscribe;
  }, [manifestUrl, nativeViewport, nativeConfigured, nativeMapRoot, nativeMapVersionId, nativeReleaseDigest, useNative]);

  useEffect(() => {
    if (useNative) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const generation = ++generationRef.current;
    setError(null);
    onCapabilitiesRef.current?.([]);
    diagnosticsRef.current?.mapLoadStarted(manifestUrl);
    viewer.loadMap(manifestUrl).then(() => {
      if (generation !== generationRef.current) return;
      diagnosticsRef.current?.mapLoadSucceeded(manifestUrl);
      onMapLoadedRef.current?.(manifestUrl);
      onCapabilitiesRef.current?.(viewer.getCapabilities());
    }).catch((reason: unknown) => {
      if (generation !== generationRef.current) return;
      setError(reason);
      onErrorRef.current?.(reason, manifestUrl);
    });
  }, [manifestUrl, useNative]);

  if (useNative) {
    const readiness = nativeUnavailable ? 'error' : (nativeReadiness ?? 'starting');
    return <div aria-label={ariaLabel} className={className} role={role} tabIndex={tabIndex} style={{ ...CANVAS_STYLE, ...style, display: 'grid', placeItems: 'center' }} data-renderer="native" data-readiness={readiness}>{readiness === 'error' ? 'Native renderer unavailable; switch to WebGL.' : `Native renderer: ${readiness}`}</div>;
  }
  return <canvas ref={canvasRef} aria-label={ariaLabel} className={className} role={role} style={{ ...CANVAS_STYLE, ...style }} tabIndex={tabIndex} data-error={error ? String(error) : undefined} />;
}
