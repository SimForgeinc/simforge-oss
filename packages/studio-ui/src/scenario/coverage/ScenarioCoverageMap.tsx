"use client";

/**
 * Scenario coverage, as a map of the world rather than a render of one map.
 *
 * The datasets list shows *where* the authored scenarios are: one polygon per
 * installed map — its OpenDRIVE extents rectangle projected to WGS84 by
 * `/api/simforge/maps/footprints` — over the CARTO Voyager basemap, labelled
 * with the map's name and how many scenarios it holds. Clicking a region
 * selects that map; clicking bare basemap clears the selection.
 *
 * This is the whole 2D surface: no measure tools, no satellite, no terrain, no
 * WebGL city. Opening a scenario for editing is what mounts the 3D world, and
 * the camera choreography that hands over to it is driven from outside through
 * `focus` / `onFocusSettled`: set `focus` to fly to one map's footprint, clear
 * it to fly back out to the whole coverage extent.
 */

import * as stylex from "@stylexjs/stylex";
import { useEffect, useMemo, useRef, useState } from "react";
// Aliased: the component body uses the global `Map` for its lookups.
import MapCanvas, { Layer, Marker, Source } from "react-map-gl/maplibre";
import type { LngLatBoundsLike, MapLayerMouseEvent, MapRef } from "react-map-gl/maplibre";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { ScenarioMapCoverageDto } from "@simforge-oss/studio-host";
import "maplibre-gl/dist/maplibre-gl.css";
import { BASEMAPS } from "../../lib/maps/basemaps";
import { useStudioHost } from "../../host";
import type { ScenarioMapGroup } from "../list/document-map-groups";
import { styles } from "./ScenarioCoverageMap.stylex";

/** The pale, labelled CARTO style: a reference map, not a picture. */
const VOYAGER_STYLE_URL = BASEMAPS.find((basemap) => basemap.id === "voyager")!.url;

/** Fly duration for a focus change, matching the editor hand-off fade. */
const FLY_MS = 1600;
const FIT_PADDING_PX = 72;
/** A single map is ~1 km across; without a ceiling `fitBounds` lands in rooftops. */
const FOCUS_MAX_ZOOM = 15.5;
const COVERAGE_FILL = "scenario-coverage-fill";

/** `easeInOutQuad` — the camera leaves and arrives at rest. */
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

type CoverageFeature = Feature<Polygon, { mapVersionId: string }>;

export type ScenarioCoverageMapProps = {
  /** The scenario groups to draw coverage for; the source of every label and count. */
  maps: ScenarioMapGroup[];
  selectedMapVersionId: string | null;
  onSelectMap: (mapVersionId: string | null) => void;
  /** Non-null flies the camera to that map's footprint; null flies back out to all coverage. */
  focus: { mapVersionId: string } | null;
  /** Fired once per completed fly, in both directions. */
  onFocusSettled?: () => void;
  xstyle?: stylex.StyleXStyles;
};

/** South-west / north-east corners of a set of rings, or null when there are none. */
function boundsOf(polygons: Array<Array<[number, number]>>): LngLatBoundsLike | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of polygons) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  if (west > east || south > north) return null;
  return [
    [west, south],
    [east, north],
  ];
}

export function ScenarioCoverageMap({
  maps,
  selectedMapVersionId,
  onSelectMap,
  focus,
  onFocusSettled,
  xstyle,
}: ScenarioCoverageMapProps) {
  const studioHost = useStudioHost();
  const mapRef = useRef<MapRef | null>(null);
  const [coverage, setCoverage] = useState<ScenarioMapCoverageDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hoveredMapVersionId, setHoveredMapVersionId] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void studioHost.artifacts
      .listMapFootprints(abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setCoverage(next);
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setCoverage({ footprints: [], unprojected: [] });
        setLoadError(reason instanceof Error ? reason.message : "Map coverage could not be loaded.");
      });
    return () => abort.abort();
  }, [studioHost]);

  /** Only maps that actually hold scenarios are coverage; `""` is the no-map group. */
  const groupsByMapVersionId = useMemo(() => {
    const byId = new Map<string, ScenarioMapGroup>();
    for (const group of maps) {
      if (group.mapVersionId) byId.set(group.mapVersionId, group);
    }
    return byId;
  }, [maps]);

  const covered = useMemo(
    () => (coverage?.footprints ?? []).filter((footprint) => groupsByMapVersionId.has(footprint.mapVersionId)),
    [coverage, groupsByMapVersionId],
  );

  /**
   * Maps that hold scenarios but cannot be drawn, with why: the map exists and
   * the author should see that, rather than wonder where their scenarios went.
   */
  const unplaced = useMemo(() => {
    if (!coverage) return [];
    const drawn = new Set(covered.map((footprint) => footprint.mapVersionId));
    const reasons = new Map(coverage.unprojected.map((entry) => [entry.mapVersionId, entry.reason]));
    return [...groupsByMapVersionId.values()]
      .filter((group) => !drawn.has(group.mapVersionId))
      .map((group) => ({
        group,
        reason: reasons.get(group.mapVersionId) ?? "not installed on this computer",
      }));
  }, [covered, coverage, groupsByMapVersionId]);

  const data = useMemo<FeatureCollection<Polygon, { mapVersionId: string }>>(() => ({
    type: "FeatureCollection",
    features: covered.map((footprint): CoverageFeature => ({
      type: "Feature",
      id: footprint.mapVersionId,
      properties: { mapVersionId: footprint.mapVersionId },
      geometry: { type: "Polygon", coordinates: [footprint.polygon] },
    })),
  }), [covered]);

  const allBounds = useMemo(() => boundsOf(covered.map((footprint) => footprint.polygon)), [covered]);
  const boundsByMapVersionId = useMemo(() => {
    const byId = new Map<string, LngLatBoundsLike>();
    for (const footprint of covered) {
      const bounds = boundsOf([footprint.polygon]);
      if (bounds) byId.set(footprint.mapVersionId, bounds);
    }
    return byId;
  }, [covered]);

  const focusedMapVersionId = focus?.mapVersionId ?? null;
  const fittedRef = useRef(false);
  // The focus the camera already stands at. Seeded with the mount value so a
  // list that mounts unfocused frames all coverage without reporting a fly.
  const appliedFocusRef = useRef<string | null>(focusedMapVersionId);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !allBounds) return;
    const first = !fittedRef.current;
    if (!first && appliedFocusRef.current === focusedMapVersionId) return;
    fittedRef.current = true;
    appliedFocusRef.current = focusedMapVersionId;

    const target = focusedMapVersionId ? boundsByMapVersionId.get(focusedMapVersionId) : allBounds;
    if (!target) {
      // Focusing a map we cannot draw moves no camera, but the hand-off that
      // is waiting on this fly must still proceed.
      onFocusSettled?.();
      return;
    }
    const duration = first ? 0 : FLY_MS;
    map.fitBounds(target, {
      padding: FIT_PADDING_PX,
      duration,
      easing: easeInOut,
      maxZoom: FOCUS_MAX_ZOOM,
    });
    if (duration === 0) {
      // The initial all-coverage framing is not a fly and settles nothing.
      if (focusedMapVersionId) onFocusSettled?.();
      return;
    }
    map.once("moveend", () => onFocusSettled?.());
  }, [allBounds, boundsByMapVersionId, focusedMapVersionId, onFocusSettled, ready]);

  const activeIds = useMemo(
    () => [hoveredMapVersionId, selectedMapVersionId].filter((id): id is string => id !== null),
    [hoveredMapVersionId, selectedMapVersionId],
  );

  const onMapClick = (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    const mapVersionId = (feature?.properties as { mapVersionId?: string } | undefined)?.mapVersionId;
    onSelectMap(mapVersionId ?? null);
  };

  return (
    <div {...stylex.props(styles.root, xstyle)} data-testid="scenario-coverage-map">
      <MapCanvas
        ref={mapRef}
        mapStyle={VOYAGER_STYLE_URL}
        initialViewState={{ longitude: -98, latitude: 39, zoom: 2.4 }}
        interactiveLayerIds={[COVERAGE_FILL]}
        cursor={hoveredMapVersionId ? "pointer" : "grab"}
        attributionControl={{ compact: true }}
        onLoad={() => setReady(true)}
        onClick={onMapClick}
        onMouseMove={(event: MapLayerMouseEvent) => {
          const feature = event.features?.[0];
          const id = (feature?.properties as { mapVersionId?: string } | undefined)?.mapVersionId ?? null;
          setHoveredMapVersionId(id);
        }}
        onMouseLeave={() => setHoveredMapVersionId(null)}
        {...stylex.props(styles.map)}
      >
        <Source id="scenario-coverage" type="geojson" data={data}>
          <Layer
            id={COVERAGE_FILL}
            type="fill"
            paint={{ "fill-color": "#0a0a0a", "fill-opacity": 0.16 }}
          />
          <Layer
            id="scenario-coverage-outline"
            type="line"
            paint={{ "line-color": "#0a0a0a", "line-width": 1.2, "line-opacity": 0.45 }}
          />
          <Layer
            id="scenario-coverage-active-fill"
            type="fill"
            filter={["in", ["get", "mapVersionId"], ["literal", activeIds]]}
            paint={{ "fill-color": "#e8e044", "fill-opacity": 0.42 }}
          />
          <Layer
            id="scenario-coverage-active-outline"
            type="line"
            filter={["in", ["get", "mapVersionId"], ["literal", activeIds]]}
            paint={{ "line-color": "#0a0a0a", "line-width": 2.4, "line-opacity": 0.9 }}
          />
        </Source>

        {covered.map((footprint) => {
          const group = groupsByMapVersionId.get(footprint.mapVersionId);
          if (!group) return null;
          const selected = group.mapVersionId === selectedMapVersionId;
          return (
            <Marker
              key={footprint.mapVersionId}
              longitude={footprint.center[0]}
              latitude={footprint.center[1]}
            >
              {/* The handler sits on the label, not on `Marker`: MapLibre's own
                  marker click never reaches the canvas, so the map's click
                  handler cannot clear the selection the label just made. */}
              <div
                {...stylex.props(styles.label, selected && styles.labelSelected)}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectMap(footprint.mapVersionId);
                }}
                onMouseEnter={() => setHoveredMapVersionId(footprint.mapVersionId)}
                onMouseLeave={() => setHoveredMapVersionId(null)}
              >
                <span {...stylex.props(styles.labelName)}>{group.displayLabel}</span>
                <span {...stylex.props(styles.labelCount)}>
                  {group.documents.length} {group.documents.length === 1 ? "scenario" : "scenarios"}
                </span>
              </div>
            </Marker>
          );
        })}
      </MapCanvas>

      {!coverage && <div {...stylex.props(styles.status)}>Locating maps…</div>}

      {(loadError || unplaced.length > 0) && (
        <div {...stylex.props(styles.legend)}>
          <span {...stylex.props(styles.legendTitle)}>Not on the map</span>
          {loadError && <span {...stylex.props(styles.legendRow)}>{loadError}</span>}
          {unplaced.map(({ group, reason }) => (
            <span key={group.groupKey} {...stylex.props(styles.legendRow)}>
              {group.displayLabel} — {reason}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
