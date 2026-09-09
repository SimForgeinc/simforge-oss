import { Layer, Source } from "react-map-gl/maplibre";
import type { FeatureCollection, LineString, Polygon } from "geojson";

/** Props for the CandidateLocationLayers component. */
type CandidateLocationLayersProps = {
  data: FeatureCollection<LineString | Polygon>;
};

/** Render dashed polygon outline for a selected candidate location. */
export function CandidateLocationLayers({ data }: CandidateLocationLayersProps) {
  return (
    <Source id="selected-candidate-location" type="geojson" data={data}>
      <Layer
        id="selected-candidate-location-fill"
        type="fill"
        paint={{
          "fill-color": "#f97316",
          "fill-opacity": 0.12,
        }}
      />
      <Layer
        id="selected-candidate-location-line"
        type="line"
        paint={{
          "line-color": "#f97316",
          "line-width": 2,
          "line-dasharray": [2, 2],
        }}
      />
    </Source>
  );
}
