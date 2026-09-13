"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import {
  CityView,
  type CityViewProps,
} from "@simforge-oss/viewer/react";
import type { CityViewer } from "@simforge-oss/viewer";
import type {
  EditorState,
  ScenarioMapEntry,
} from "@simforge-oss/editor";
import type { ScenarioAuthoringQuality } from "../../../lib/scenario/contracts";
import { CloudActivityIndicator } from "../../../components/CloudLoadingSurface";
import { cn } from "../../../lib/utils";
import { AUTHORING_QUALITY } from "../authoring-quality";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./EditorCanvasRegion.stylex";

/**
 * OWNS: the `CityView` host element and the actor-library overlay.
 *
 * `hostRef` is owned by the surface, not by this region: `useEditorRuntime`
 * attaches the input controller to it, and the runtime hook has to live above
 * both this region and the inspector that reads its state.
 *
 * `CityView` is keyed on `quality` because `maxPixelRatio` and `antialias` are
 * WebGL context-creation options — they cannot be changed on a live context, so
 * a quality change genuinely is a new viewer. Nothing else here may remount.
 */
export function EditorCanvasRegion({
  hostRef,
  map,
  quality,
  onViewerReady,
  onMapLoaded,
  state,
  error,
  externalWorld = false,
  children,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  map: ScenarioMapEntry;
  quality: ScenarioAuthoringQuality;
  onViewerReady: (viewer: CityViewer) => void;
  onMapLoaded?: (manifestUrl: string) => void;
  state: EditorState | null;
  error: string | null;
  /** Use the already-mounted datasets world instead of creating a second viewer. */
  externalWorld?: boolean;
  children?: ReactNode;
}) {
  const preset = AUTHORING_QUALITY[quality];
  const activeViewerRef = useRef<CityViewer | null>(null);
  const registerViewer = useCallback((viewer: CityViewer) => {
    activeViewerRef.current = viewer;
    onViewerReady(viewer);
  }, [onViewerReady]);
  const reportMapLoaded = useCallback((viewer: CityViewer, manifestUrl: string) => {
    if (activeViewerRef.current !== viewer) return;
    onMapLoaded?.(manifestUrl);
  }, [onMapLoaded]);

  return (
    <div
      ref={hostRef}
      {...stylex.props(externalWorld ? styles.relFillClip : styles.relFillClip2)}
      data-tutorial="canvas"
      data-testid="scenario-editor-canvas-region"
      data-external-world={String(externalWorld)}
    >
      {/* The name, role and tab stop go on the canvas itself. `tabIndex` is the
          load-bearing one: the viewer binds its key handling to this element, so
          without a tab stop there is no keyboard route into the scene at all. */}
      {!externalWorld ? (
        <EditorCityViewInstance
          key={quality}
          manifestUrl={map.manifestUrl}
          options={{
            maxPixelRatio: preset.maxPixelRatio,
            antialias: preset.antialias,
            cinematicLighting: preset.cinematicLighting,
          }}
          onViewerReady={registerViewer}
          onViewerMapLoaded={reportMapLoaded}
          className={stylex.props(styles.wideTall).className}
          ariaLabel={`${map.label} 3D scene. Click an actor to select it, drag to orbit.`}
          role="application"
          tabIndex={0}
        />
      ) : null}
      {!state ? (
        error ? (
          <div
            {...stylex.props(styles.absXsDanger)}
            data-testid="scenario-map-status"
            role="alert"
            aria-live="assertive"
          >
            {error}
          </div>
        ) : (
          <CloudActivityIndicator
            xstyle={styles.absXsInert}
            label="Loading map and lane topology…"
            testId="scenario-map-status"
          />
        )
      ) : null}

      <div {...stylex.props(styles.live)}>
        {children}
      </div>
    </div>
  );
}

/** Give each keyed CityView its own viewer identity so stale loads cannot ready a replacement. */
function EditorCityViewInstance({
  onViewerMapLoaded,
  onViewerReady,
  ...props
}: Omit<CityViewProps, "onMapLoaded" | "onReady"> & {
  readonly onViewerMapLoaded: (viewer: CityViewer, manifestUrl: string) => void;
  readonly onViewerReady: (viewer: CityViewer) => void;
}) {
  const viewerRef = useRef<CityViewer | null>(null);
  useEffect(() => () => {
    viewerRef.current = null;
  }, []);

  return (
    <CityView
      {...props}
      onReady={(viewer) => {
        viewerRef.current = viewer;
        onViewerReady(viewer);
      }}
      onMapLoaded={(manifestUrl) => {
        const viewer = viewerRef.current;
        if (viewer) onViewerMapLoaded(viewer, manifestUrl);
      }}
    />
  );
}
