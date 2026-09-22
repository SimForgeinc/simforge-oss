"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./MapElementInspector.stylex";

import { useEffect, useState } from "react";
import { ChevronRight, Copy, Check, MapPin, X } from "lucide-react";
import type { SelectedGeoJSONFeaturePayload } from "@/app/lib/maps/frontend/feature-inspection-types";
import { useStreetFactsByFeatureId } from "@/app/lib/maps/frontend/use-street-facts-index";
import { JsonTreeView } from "@/app/components/JsonTreeView";

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
      <div {...stylex.props(styles.emptyState)}>
        <MapPin {...stylex.props(styles.emptyStateIcon)} />
        <p {...stylex.props(styles.emptyStateMessage)}>Click a feature on the map to inspect it.</p>
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.inspectorContainer)} data-testid="map-element-inspector">
      <div {...stylex.props(styles.selectionHeader)}>
        <p {...stylex.props(styles.selectionTitle)}>
          Selected Features ({selectedFeatures.length})
        </p>
        {onClearSelection && (
          <button
            type="button"
            onClick={onClearSelection}
            title="Clear selection"
            {...stylex.props(styles.clearSelectionButton)}
          >
            <X {...stylex.props(styles.clearSelectionIcon)} />
          </button>
        )}
      </div>
      <div {...stylex.props(styles.featureList)}>
        {selectedFeatures.map((f) => {
          const isSelected = f.id === selectedFeatureId;
          const isExpanded = f.id === expandedFeatureId;
          return (
            <div
              key={f.id}
              {...stylex.props(styles.elementCard, isSelected ? styles.elementCardSelected : styles.elementCardIdle)}
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
                {...stylex.props(styles.featureToggleButton)}
              >
                <ChevronRight
                  {...stylex.props(styles.chevronLg, isExpanded && styles.rotate90)}
                />
                <span {...stylex.props(styles.featureSummary)} data-testid="selected-feature-summary">
                  {f.summary}
                </span>
              </button>
              {isExpanded && (
                <div {...stylex.props(styles.expandedDetails)}>
                  <div {...stylex.props(styles.featureActionRow)}>
                    <p {...stylex.props(styles.geometryLabel)}>
                      Geometry: <span {...stylex.props(styles.detailValue)}>{f.geometryType}</span>
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
                      {...stylex.props(styles.copyGeoJsonButton)}
                    >
                      {copiedFeatureId === f.id ? (
                        <Check {...stylex.props(styles.copiedIcon)} />
                      ) : (
                        <Copy {...stylex.props(styles.copyIcon)} />
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
                      <div {...stylex.props(styles.streetFactsSection)} data-testid="street-facts">
                        <h3 {...stylex.props(styles.streetFactsHeading)}>
                          Street facts
                        </h3>
                        <div {...stylex.props(styles.detailRow)}>
                          <span {...stylex.props(styles.detailLabel)}>Street</span>
                          <span {...stylex.props(styles.detailValue)}>{street.streetName}</span>
                        </div>
                        {street.roadClass && (
                          <div {...stylex.props(styles.detailRow)}>
                            <span {...stylex.props(styles.detailLabel)}>Road class</span>
                            <span {...stylex.props(styles.detailValue)}>{street.roadClass}</span>
                          </div>
                        )}
                        {street.overtureSpeedLimitMph != null && (
                          <div {...stylex.props(styles.detailRow)}>
                            <span {...stylex.props(styles.detailLabel)}>Posted limit</span>
                            <span {...stylex.props(styles.detailValue)}>
                              {street.overtureSpeedLimitMph} mph
                              <span {...stylex.props(styles.overtureSource)}>(Overture)</span>
                            </span>
                          </div>
                        )}
                        {street.laneCount != null && (
                          <div {...stylex.props(styles.detailRow)}>
                            <span {...stylex.props(styles.detailLabel)}>Lanes</span>
                            <span {...stylex.props(styles.detailValue)}>{street.laneCount}</span>
                          </div>
                        )}
                        <div {...stylex.props(styles.sectionDivider)} />
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
                          <div {...stylex.props(styles.identifierSection)}>
                            {type != null && (
                              <div {...stylex.props(styles.detailRow)}>
                                <span {...stylex.props(styles.detailLabel)}>Type</span>
                                <span {...stylex.props(styles.detailValue)}>{String(type)}</span>
                              </div>
                            )}
                            {id != null && (
                              <div {...stylex.props(styles.detailRow)}>
                                <span {...stylex.props(styles.detailLabel)}>Id</span>
                                <span {...stylex.props(styles.identifierValue)}>
                                  {String(id).replace(/^\{|\}$/g, "")}
                                </span>
                              </div>
                            )}
                            <div {...stylex.props(styles.sectionDivider)} />
                          </div>
                        )}
                        <h3 {...stylex.props(styles.propertiesHeading)}>
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
