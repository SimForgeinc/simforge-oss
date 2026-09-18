"use client";

/**
 * Scenario coverage, as a map of the world rather than a render of one map.
 *
 * The datasets list shows *where* the authored scenarios are: one polygon per
 * installed map — its OpenDRIVE extents rectangle projected to WGS84 by
 * `/api/simforge/maps/footprints` — over the product's monochrome basemap,
 * labelled with the map's name and how many scenarios it holds. Clicking a
 * region selects that map; clicking bare basemap clears the selection.
 *
 * This is the whole 2D surface: no measure tools, no satellite, no terrain, no
 * WebGL city. It is absent while editing: returning to the list never waits
 * for a camera callback or a basemap request to complete.
 */

import * as stylex from "@stylexjs/stylex";
import { useEffect, useMemo, useRef, useState } from "react";
// Aliased: the component body uses the global `Map` for its lookups.
import MapCanvas, { Layer, Marker, Source } from "react-map-gl/maplibre";
import type { LngLatBoundsLike, MapLayerMouseEvent, MapRef } from "react-map-gl/maplibre";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { ScenarioMapCoverageDto } from "@simforge-oss/studio-host";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  DEFAULT_BASEMAP,
  MAP_ACCENT,
  MONOCHROME_RAMPS,
  PLATE_BASEMAP_STYLE,
  fetchMonochromeBasemapStyle,
  type BasemapStyle,
} from "../../lib/maps/basemaps";
import { useStudioHost } from "../../host";
import type { ScenarioMapGroup } from "../list/document-map-groups";
import { styles } from "./ScenarioCoverageMap.stylex";

/**
 * Coverage ink, on the basemap's own ramp: `ramp.label` is the rung that reads
 * against the ground whichever way the ramp runs, and the accent is the one
 * saturated colour on the surface — so a covered region is grey until it is
 * hovered or selected, and then it is the product's yellow.
 */
const COVERAGE_RAMP = MONOCHROME_RAMPS[DEFAULT_BASEMAP];

const FIT_PADDING_PX = 72;
/** A single map is ~1 km across; without a ceiling `fitBounds` lands in rooftops. */
const FOCUS_MAX_ZOOM = 15.5;
const COVERAGE_FILL = "scenario-coverage-fill";


type CoverageFeature = Feature<Polygon, { mapVersionId: string }>;

export type ScenarioCoverageMapProps = {
  /** The scenario groups to draw coverage for; the source of every label and count. */
  maps: ScenarioMapGroup[];
  selectedMapVersionId: string | null;
  onSelectMap: (mapVersionId: string | null) => void;
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
  xstyle,
}: ScenarioCoverageMapProps) {
  const studioHost = useStudioHost();
  const mapRef = useRef<MapRef | null>(null);
  const [coverage, setCoverage] = useState<ScenarioMapCoverageDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hoveredMapVersionId, setHoveredMapVersionId] = useState<string | null>(null);
  // The plate until the recoloured ground lands: the canvas needs a style now.
  const [basemapStyle, setBasemapStyle] = useState<BasemapStyle>(PLATE_BASEMAP_STYLE);

  useEffect(() => {
    let cancelled = false;
    void fetchMonochromeBasemapStyle(DEFAULT_BASEMAP)
      .then((style) => {
        if (!cancelled) setBasemapStyle(style);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        // The plate stays: coverage over an empty ground still answers "where".
        setLoadError(reason instanceof Error ? reason.message : "The basemap could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const fittedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !allBounds || fittedRef.current) return;
    fittedRef.current = true;
    map.fitBounds(allBounds, { padding: FIT_PADDING_PX, duration: 0, maxZoom: FOCUS_MAX_ZOOM });
  }, [allBounds, ready]);

  // Hover and selection are separate rungs of the accent, so pointing at a
  // region never looks like having chosen it.
  const hoveredIds = useMemo(
    () => (hoveredMapVersionId ? [hoveredMapVersionId] : []),
    [hoveredMapVersionId],
  );
  const selectedIds = useMemo(
    () => (selectedMapVersionId ? [selectedMapVersionId] : []),
    [selectedMapVersionId],
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
        // Same self-hosted worker the Maps app uses: MapLibre's bundled worker
        // does not survive the app's bundler, and without it the canvas draws
        // nothing at all.
        workerUrl="/maplibre/maplibre-gl-worker.mjs"
        mapStyle={basemapStyle as never}
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
            paint={{ "fill-color": COVERAGE_RAMP.label, "fill-opacity": 0.1 }}
          />
          <Layer
            id="scenario-coverage-outline"
            type="line"
            paint={{ "line-color": COVERAGE_RAMP.label, "line-width": 1.2, "line-opacity": 0.35 }}
          />
          <Layer
            id="scenario-coverage-hover-fill"
            type="fill"
            filter={["in", ["get", "mapVersionId"], ["literal", hoveredIds]]}
            paint={{ "fill-color": MAP_ACCENT, "fill-opacity": 0.2 }}
          />
          <Layer
            id="scenario-coverage-selected-fill"
            type="fill"
            filter={["in", ["get", "mapVersionId"], ["literal", selectedIds]]}
            paint={{ "fill-color": MAP_ACCENT, "fill-opacity": 0.45 }}
          />
          <Layer
            id="scenario-coverage-selected-outline"
            type="line"
            filter={["in", ["get", "mapVersionId"], ["literal", selectedIds]]}
            paint={{ "line-color": MAP_ACCENT, "line-width": 2.4, "line-opacity": 0.95 }}
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
