"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, Box, Loader2 } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import type {
  CityViewer,
  ViewerMarker,
  ViewerOverlayState,
  ViewerPath,
  ViewerPoint3,
} from "@simforge-oss/viewer";
import type { SearchResultMarker } from "@/app/components/map-assets-map/layers/SearchResultMarkersLayer";

const CityViewDynamic = dynamic(
  () => import("@simforge-oss/viewer/react").then((module) => module.CityView),
  {
    ssr: false,
    loading: () => (
      <div className={stylex.props(styles.s_766).className}>
        <div className={stylex.props(styles.s_769).className}>
          <Box className={stylex.props(styles.s_765).className} />
        </div>
      </div>
    ),
  },
);

export interface DigitalTwinFocusTarget {
  position: ViewerPoint3;
  radius: number;
}

export interface ProximityArrow3D {
  id: string;
  points: ViewerPoint3[];
  highlight?: boolean;
}

interface Props {
  asset: MapAsset;
  focusTarget?: DigitalTwinFocusTarget | null;
  resetViewNonce?: number;
  searchResultMarkers?: SearchResultMarker[];
  hoveredSearchResultId?: string | null;
  proximityArrows?: ProximityArrow3D[];
}

/** The map-detail 3D surface, backed by the same packaged viewer as the editor. */
export function DigitalTwinViewerPanel({
  asset,
  focusTarget,
  resetViewNonce,
  searchResultMarkers,
  hoveredSearchResultId,
  proximityArrows,
}: Props) {
  const manifestUrl = `/api/map-assets/${asset.map_asset_id}/3d-asset/manifest.json`;
  const hasArtifact = asset.artifacts?.some(
    (artifact) => (artifact.artifact_type as string) === "3d_manifest",
  );
  const [has3D, setHas3D] = useState<boolean | null>(hasArtifact ? true : null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const viewerRef = useRef<CityViewer | null>(null);
  const [mapGeneration, setMapGeneration] = useState(0);
  const previousResetNonce = useRef(resetViewNonce);

  useEffect(() => {
    setHas3D(hasArtifact ? true : null);
    setViewerError(null);
  }, [asset.map_asset_id, hasArtifact]);

  useEffect(() => {
    if (hasArtifact || has3D === true) return;
    const controller = new AbortController();
    fetch(manifestUrl, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setHas3D(response.ok);
        controller.abort();
      })
      .catch(() => {
        if (!controller.signal.aborted) setHas3D(false);
      });
    return () => controller.abort();
  }, [hasArtifact, has3D, manifestUrl]);

  const overlayState = useMemo<ViewerOverlayState>(() => {
    const pins = (searchResultMarkers ?? [])
      .filter((marker) => marker.scenePosition != null)
      .map((marker) => ({
        id: marker.id,
        position: marker.scenePosition!,
        highlighted: marker.id === hoveredSearchResultId,
      }));
    const paths: ViewerPath[] = (proximityArrows ?? []).map((path) => ({
      ...path,
      highlighted: path.highlight,
      arrow: true,
    }));
    const markers: ViewerMarker[] = [];
    if (focusTarget) {
      markers.push({ id: "location-focus", position: focusTarget.position, color: "#f97316" });
    }
    return { pins, paths, markers };
  }, [
    focusTarget,
    hoveredSearchResultId,
    proximityArrows,
    searchResultMarkers,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || mapGeneration === 0) return;
    if (focusTarget) viewer.focusOnLocation(focusTarget.position, focusTarget.radius);
    viewer.setOverlays(overlayState);
  }, [focusTarget, mapGeneration, overlayState]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || resetViewNonce === undefined || resetViewNonce === previousResetNonce.current) return;
    previousResetNonce.current = resetViewNonce;
    viewer.resetCamera();
  }, [mapGeneration, resetViewNonce]);

  const onReady = useCallback((viewer: CityViewer) => {
    viewerRef.current = viewer;
  }, []);

  if (has3D === null) {
    return (
      <div className={stylex.props(styles.s_766).className}>
        <Loader2 className={stylex.props(styles.s_767).className} />
      </div>
    );
  }

  if (!has3D) {
    return (
      <div className={stylex.props(styles.s_768).className}>
        <div className={stylex.props(styles.s_769).className}>
          <Box className={stylex.props(styles.s_770).className} />
        </div>
        <div className={stylex.props(styles.s_771).className}>
          <p className={stylex.props(styles.s_880).className}>Digital Twin Viewer</p>
          <p className={stylex.props(styles.s_773).className}>
            No 3D digital twin assets found for this map. Switch to Map mode to explore in 2D.
          </p>
        </div>
      </div>
    );
  }

  if (viewerError) {
    return (
      <div className={stylex.props(styles.s_774).className}>
        <AlertTriangle className={stylex.props(styles.s_775).className} />
        <p className={stylex.props(styles.s_776).className}>{viewerError}</p>
      </div>
    );
  }

  return (
    <div className={stylex.props(styles.s_801).className}>
      <CityViewDynamic
        manifestUrl={manifestUrl}
        options={{ assetVariant: "auto", ktx2TranscoderPath: "/basis/" }}
        onReady={onReady}
        onMapLoaded={() => setMapGeneration((generation) => generation + 1)}
        onError={(error) => setViewerError(error instanceof Error ? error.message : String(error))}
        ariaLabel={`3D digital twin of ${asset.name}`}
        role="application"
        tabIndex={0}
        className={stylex.props(styles.s_778).className}
      />
    </div>
  );
}
