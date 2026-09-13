import { useCallback, useRef } from "react";
import * as stylex from "@stylexjs/stylex";
import { Layer, Marker, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";
import { styles } from "../map-canvas.stylex";
import {
  measureOverlayGeoJSON,
  measureReadout,
  type MeasurePoint,
} from "@/app/lib/maps/frontend/measure-distance";

type MeasureDistanceLayersProps = {
  points: MeasurePoint[];
  cursor: MeasurePoint | null;
  onClear: () => void;
};

/**
 * Overlay for the measure tool: endpoint dots, the measured segment (dashed
 * while rubber-banding to the cursor, solid once pinned), and a midpoint pill
 * with the great-circle distance. The pinned pill carries a ✕ to clear; the
 * live preview pill ignores the pointer so it can never swallow the second
 * click.
 */
export function MeasureDistanceLayers({
  points,
  cursor,
  onClear,
}: MeasureDistanceLayersProps) {
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;

  // MapLibre's click handler lives on the canvas container — an ancestor of
  // marker DOM — so a React-level stopPropagation fires too late to shield
  // it. Intercept natively on the pill itself, otherwise the ✕ click would
  // also register as a map click and start a new measurement under the pill.
  const attachPill = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const onPillClick = (event: MouseEvent) => {
      event.stopPropagation();
      const target = event.target as Element | null;
      if (target?.closest("[data-measure-clear]")) onClearRef.current();
    };
    el.addEventListener("click", onPillClick);
    return () => el.removeEventListener("click", onPillClick);
  }, []);

  const data = measureOverlayGeoJSON(points, cursor);
  const readout = measureReadout(points, cursor);
  if (!data) return null;

  return (
    <>
      <Source id="measure-distance" type="geojson" data={data as never}>
        <Layer
          id="measure-distance-line"
          type="line"
          filter={["==", ["get", "kind"], "fixed"] as never}
          layout={{ "line-cap": "round" }}
          paint={{
            "line-color": C.fg,
            "line-width": 2.5,
            "line-opacity": 0.9,
          }}
        />
        <Layer
          id="measure-distance-preview"
          type="line"
          filter={["==", ["get", "kind"], "preview"] as never}
          paint={{
            "line-color": C.fg,
            "line-width": 2,
            "line-opacity": 0.75,
            "line-dasharray": [1.5, 1.5] as never,
          }}
        />
        <Layer
          id="measure-distance-endpoint"
          type="circle"
          filter={["==", ["get", "kind"], "endpoint"] as never}
          paint={{
            "circle-radius": 4.5,
            "circle-color": C.fg,
            "circle-stroke-width": 2,
            "circle-stroke-color": C.bg,
          }}
        />
      </Source>
      {readout && (
        <Marker
          longitude={readout.position.lng}
          latitude={readout.position.lat}
          anchor="bottom"
          offset={[0, -10] as never}
          {...stylex.props(
            styles.measureMarker,
            readout.pinned ? styles.pointerEventsAuto : styles.pointerEventsNone,
          )}
        >
          <div ref={attachPill} {...stylex.props(styles.measurePill)}>
            <span {...stylex.props(styles.measureValue)}>{readout.label}</span>
            {readout.pinned && (
              <button
                type="button"
                data-measure-clear
                aria-label="Clear measurement"
                title="Clear measurement"
                {...stylex.props(styles.measureClear)}
              >
                ✕
              </button>
            )}
          </div>
        </Marker>
      )}
    </>
  );
}
