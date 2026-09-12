"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { useEffect, useState } from "react";
import { ChevronRight, Copy, Check, MapPin, X } from "lucide-react";
import type { SelectedGeoJSONFeaturePayload } from "@/app/lib/maps/frontend/feature-inspection-types";
import { useStreetFactsByFeatureId } from "@/app/lib/maps/frontend/use-street-facts-index";
import { JsonTreeView } from "@/app/components/JsonTreeView";
import { cn } from "@simforge-oss/studio-ui/lib/utils";

/** Props for the MapElementInspector component. */
export type MapElementInspectorProps = {
  selectedFeatures: SelectedGeoJSONFeaturePayload[];
  selectedFeatureId: number | null;
  onSelectFeatureId?: (id: number) => void;
  onClearSelection?: () => void;
  onHighlightId?: (guid: string) => void;
  onSelectId?: (guid: string) => void;
  knownGuids?: Set<string>;
  /** When provided, lane features show their street's search-index facts
   *  (resolved name, road class, Overture posted speed limit). */
  mapAssetId?: string;
};

/** Inspect selected GeoJSON features showing their properties and geometry type. */
export function MapElementInspector({
  selectedFeatures,
  selectedFeatureId,
  onSelectFeatureId,
  onClearSelection,
  onHighlightId,
  onSelectId,
  knownGuids,
  mapAssetId,
}: MapElementInspectorProps) {
  const [expandedFeatureId, setExpandedFeatureId] = useState<number | null>(null);
  const [copiedFeatureId, setCopiedFeatureId] = useState<number | null>(null);
  const streetFactsByFeatureId = useStreetFactsByFeatureId(
    mapAssetId,
    selectedFeatures.length > 0,
  );

  useEffect(() => {
    if (selectedFeatures.length > 0) {
      const id = selectedFeatureId ?? selectedFeatures[0]?.id ?? null;
      setExpandedFeatureId(id);
    } else {
      setExpandedFeatureId(null);
    }
  }, [selectedFeatures, selectedFeatureId]);

  if (selectedFeatures.length === 0) {
    return (
      <div className={stylex.props(styles.s_480).className}>
        <MapPin className={stylex.props(styles.s_481).className} />
        <p className={stylex.props(styles.s_948).className}>Click a feature on the map to inspect it.</p>
      </div>
    );
  }

  return (
    <div className={stylex.props(styles.s_960).className} data-testid="map-element-inspector">
      <div className={stylex.props(styles.s_484).className}>
        <p className={stylex.props(styles.s_485).className}>
          Selected Features ({selectedFeatures.length})
        </p>
        {onClearSelection && (
          <button
            type="button"
            onClick={onClearSelection}
            title="Clear selection"
            className={stylex.props(styles.s_486).className}
          >
            <X className={stylex.props(styles.s_991).className} />
          </button>
        )}
      </div>
      <div className={stylex.props(styles.s_879).className}>
        {selectedFeatures.map((f) => {
          const isSelected = f.id === selectedFeatureId;
          const isExpanded = f.id === expandedFeatureId;
          return (
            <div
              key={f.id}
              className={stylex.props(styles.u_954, styles.u_903, styles.u_965, styles.u_970).className}
            >
              <button
                type="button"
                onClick={() => {
                  if (f.id === expandedFeatureId) {
                    setExpandedFeatureId(null);
                  } else {
                    setExpandedFeatureId(f.id);
                    onSelectFeatureId?.(f.id);
                  }
                }}
                className={stylex.props(styles.s_489).className}
              >
                <ChevronRight
                  className={cn("size-3.5 shrink-0 transition-transform duration-150", isExpanded && "rotate-90")}
                />
                <span className={stylex.props(styles.s_490).className} data-testid="selected-feature-summary">
                  {f.summary}
                </span>
              </button>
              {isExpanded && (
                <div className={stylex.props(styles.s_491).className}>
                  <div className={stylex.props(styles.s_492).className}>
                    <p className={stylex.props(styles.s_955).className}>
                      Geometry: <span className={stylex.props(styles.s_517).className}>{f.geometryType}</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        const geojsonFeature = {
                          type: "Feature" as const,
                          geometry: f.geometry ?? { type: f.geometryType, coordinates: f.coordinates ?? [] },
                          properties: f.properties,
                        };
                        navigator.clipboard.writeText(JSON.stringify(geojsonFeature, null, 2)).then(() => {
                          setCopiedFeatureId(f.id);
                          setTimeout(() => setCopiedFeatureId(null), 2000);
                        }).catch(() => {});
                      }}
                      title="Copy feature as GeoJSON"
                      className={stylex.props(styles.s_495).className}
                    >
                      {copiedFeatureId === f.id ? (
                        <Check className={stylex.props(styles.s_496).className} />
                      ) : (
                        <Copy className={stylex.props(styles.s_927).className} />
                      )}
                      Copy GeoJSON
                    </button>
                  </div>
                  {/* Street facts from the search index — shown for driving
                      lanes so the road's resolved name, OSM road class, and
                      Overture posted limit are visible without opening the
                      raw properties tree. */}
                  {(() => {
                    const street = streetFactsByFeatureId?.get(f.id);
                    if (!street) return null;
                    return (
                      <div className={stylex.props(styles.s_498).className} data-testid="street-facts">
                        <h3 className={stylex.props(styles.s_499).className}>
                          Street facts
                        </h3>
                        <div className={stylex.props(styles.s_518).className}>
                          <span className={stylex.props(styles.s_931).className}>Street</span>
                          <span className={stylex.props(styles.s_517).className}>{street.streetName}</span>
                        </div>
                        {street.roadClass && (
                          <div className={stylex.props(styles.s_518).className}>
                            <span className={stylex.props(styles.s_931).className}>Road class</span>
                            <span className={stylex.props(styles.s_517).className}>{street.roadClass}</span>
                          </div>
                        )}
                        {street.overtureSpeedLimitMph != null && (
                          <div className={stylex.props(styles.s_518).className}>
                            <span className={stylex.props(styles.s_931).className}>Posted limit</span>
                            <span className={stylex.props(styles.s_517).className}>
                              {street.overtureSpeedLimitMph} mph
                              <span className={stylex.props(styles.s_509).className}>(Overture)</span>
                            </span>
                          </div>
                        )}
                        {street.laneCount != null && (
                          <div className={stylex.props(styles.s_518).className}>
                            <span className={stylex.props(styles.s_931).className}>Lanes</span>
                            <span className={stylex.props(styles.s_517).className}>{street.laneCount}</span>
                          </div>
                        )}
                        <div className={stylex.props(styles.s_521).className} />
                      </div>
                    );
                  })()}
                  {/* Key identifiers pulled to top */}
                  {(() => {
                    const props = f.properties as Record<string, unknown>;
                    const id = props.Id ?? props.id;
                    const type = props.Type ?? props.type;
                    const remaining = Object.fromEntries(
                      Object.entries(props).filter(
                        ([k]) => !["Id", "id", "Type", "type"].includes(k),
                      ),
                    );
                    return (
                      <>
                        {(id != null || type != null) && (
                          <div className={stylex.props(styles.s_514).className}>
                            {type != null && (
                              <div className={stylex.props(styles.s_518).className}>
                                <span className={stylex.props(styles.s_931).className}>Type</span>
                                <span className={stylex.props(styles.s_517).className}>{String(type)}</span>
                              </div>
                            )}
                            {id != null && (
                              <div className={stylex.props(styles.s_518).className}>
                                <span className={stylex.props(styles.s_931).className}>Id</span>
                                <span className={stylex.props(styles.s_520).className}>
                                  {String(id).replace(/^\{|\}$/g, "")}
                                </span>
                              </div>
                            )}
                            <div className={stylex.props(styles.s_521).className} />
                          </div>
                        )}
                        <h3 className={stylex.props(styles.s_522).className}>
                          Properties
                        </h3>
                        <JsonTreeView
                          data={remaining}
                          collapseArrays
                          onHighlightId={onHighlightId}
                          onSelectId={onSelectId}
                          knownIds={knownGuids}
                        />
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
