"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./MapMetadataSection.stylex";

import { ChevronRight, Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";

import type { MapAsset, MapAssetEnrichmentSnapshot } from "@simforge-oss/studio-shared";
import { motionRecipe, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

/** Props for the MapMetadataSection component. */
type MapMetadataSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  asset: MapAsset;
  hasExtractedMetadata: boolean;
  showPopulateMetadata: boolean;
  populateBusy: boolean;
  populateErr: string | null;
  onPopulateMetadata: () => void;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  /** Override the section header title (default: "Map Metadata"). */
  title?: string;
  /** Optional enrichment snapshot to display as a sub-section. */
  enrichment?: MapAssetEnrichmentSnapshot | null;
};

/** Display extracted map metadata (source, coordinate ref, location) with populate action. */
export function MapMetadataSection({
  open,
  onToggleOpen,
  asset,
  hasExtractedMetadata,
  showPopulateMetadata,
  populateBusy,
  populateErr,
  onPopulateMetadata,
  copiedKey,
  onCopy,
  title = "Map Metadata",
  enrichment,
}: MapMetadataSectionProps) {
  return (
    <section>
      <div {...stylex.props(styles.sectionHeaderRow)}>
        <button
          type="button"
          onClick={onToggleOpen}
          {...stylex.props([motionRecipe.colors, [typography.caps, styles.sectionToggleButton]])}
          aria-expanded={open}
        >
          <ChevronRight
            {...stylex.props([motionRecipe.transform, styles.chevron], open && styles.rotate90)}
          />
          {title}
        </button>
        {(asset.map_source != null || asset.map_coordinate_ref != null) && (
          <button
            type="button"
            onClick={() =>
              onCopy(
                JSON.stringify(
                  { map_source: asset.map_source, map_coordinate_ref: asset.map_coordinate_ref },
                  null,
                  2
                ),
                "mapMetadata"
              )
            }
            aria-label="Copy map metadata as JSON"
            title="Copy map metadata as JSON"
            {...stylex.props([motionRecipe.colors, styles.copyMetadataButton])}
          >
            {copiedKey === "mapMetadata" ? (
              <Check {...stylex.props(styles.copiedCheckIcon)} />
            ) : (
              <Copy {...stylex.props(styles.copyIcon)} />
            )}
          </button>
        )}
      </div>
      {open && (
        <div {...stylex.props(styles.metadataContent)}>
          {!hasExtractedMetadata && (
            <p {...stylex.props(styles.emptyMetadataNotice)}>
              No extracted fields yet. Upload geojson, xodr, and rrdata_xml for this map, then run{" "}
              <span {...stylex.props(styles.populateMetadataEmphasis)}>Populate metadata</span> below (or create a new map with all
              three files).
            </p>
          )}
          {asset.place_context && (
            <div>
              <h4 {...stylex.props([typography.eyebrow, styles.metadataSubsectionHeading])}>
                Location
              </h4>
              <p {...stylex.props(styles.locationValue)}>
                {[
                  asset.place_context.city,
                  asset.place_context.state,
                  asset.place_context.country_code,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            </div>
          )}
          {asset.map_source && (
            <div>
              <h4 {...stylex.props([typography.eyebrow, styles.metadataSubsectionHeading])}>
                Map source
              </h4>
              <dl {...stylex.props(styles.metadataDefinitionList)}>
                {asset.map_source.tool != null && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>Tool</dt>
                    <dd {...stylex.props(styles.metadataValue)}>{asset.map_source.tool}</dd>
                  </>
                )}
                {asset.map_source.tool_version != null && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>Version</dt>
                    <dd {...stylex.props(styles.metadataSecondaryValue)}>{asset.map_source.tool_version}</dd>
                  </>
                )}
                {asset.map_source.vendor != null && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>Vendor</dt>
                    <dd {...stylex.props(styles.metadataValue)}>{asset.map_source.vendor}</dd>
                  </>
                )}
                {asset.map_source.opendrive_version != null && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>OpenDRIVE</dt>
                    <dd {...stylex.props(styles.metadataValue)}>{asset.map_source.opendrive_version}</dd>
                  </>
                )}
                {asset.map_source.rrdata_schema_version != null && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>RR schema</dt>
                    <dd {...stylex.props(styles.metadataValue)}>{asset.map_source.rrdata_schema_version}</dd>
                  </>
                )}
                {asset.map_source.exported_at != null && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>Exported</dt>
                    <dd {...stylex.props(styles.metadataSecondaryValue)}>{asset.map_source.exported_at}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {asset.map_coordinate_ref && (
            <div>
              <h4 {...stylex.props([typography.eyebrow, styles.metadataSubsectionHeading])}>
                Coordinate reference
              </h4>
              <dl {...stylex.props(styles.metadataDefinitionList)}>
                {asset.map_coordinate_ref.origin_lat != null &&
                  asset.map_coordinate_ref.origin_lon != null && (
                    <>
                      <dt {...stylex.props(styles.metadataLabel)}>Origin</dt>
                      <dd {...stylex.props(styles.metadataValue)}>
                        {asset.map_coordinate_ref.origin_lat.toFixed(6)},{" "}
                        {asset.map_coordinate_ref.origin_lon.toFixed(6)}
                      </dd>
                    </>
                  )}
                {asset.map_coordinate_ref.utm_zone != null && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>UTM</dt>
                    <dd {...stylex.props(styles.metadataValue)}>{asset.map_coordinate_ref.utm_zone}</dd>
                  </>
                )}
                {asset.map_coordinate_ref.editor_offset_m != null && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>Editor offset</dt>
                    <dd {...stylex.props(styles.metadataValue)}>
                      {asset.map_coordinate_ref.editor_offset_m.x.toFixed(2)},{" "}
                      {asset.map_coordinate_ref.editor_offset_m.y.toFixed(2)} m
                    </dd>
                  </>
                )}
                {asset.map_coordinate_ref.projection_type != null && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>Projection</dt>
                    <dd {...stylex.props(styles.metadataValue)}>{asset.map_coordinate_ref.projection_type}</dd>
                  </>
                )}
                {asset.map_coordinate_ref.proj_string != null && (
                  <>
                    <dt {...stylex.props(styles.projLabel)}>PROJ</dt>
                    <dd {...stylex.props(styles.projStringValue)}>
                      {asset.map_coordinate_ref.proj_string}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {asset.carla_map_name && (
            <div>
              <h4 {...stylex.props([typography.eyebrow, styles.metadataSubsectionHeading])}>
                CARLA Metadata
              </h4>
              <dl {...stylex.props(styles.metadataDefinitionList)}>
                <dt {...stylex.props(styles.metadataLabel)}>Carla Map Name</dt>
                <dd {...stylex.props(styles.metadataSecondaryValue)}>{asset.carla_map_name}</dd>
              </dl>
            </div>
          )}
          {asset.metadata_last_populated_at && (
            <p {...stylex.props(styles.metadataTimestamp)}>
              Metadata last computed {new Date(asset.metadata_last_populated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </p>
          )}
          {enrichment && (
            <div>
              <h4 {...stylex.props([typography.eyebrow, styles.metadataSubsectionHeading])}>
                Third-Party Enrichment Source
              </h4>
              <dl {...stylex.props(styles.metadataDefinitionList)}>
                {enrichment.provider && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>Provider</dt>
                    <dd {...stylex.props(styles.metadataValue)}>{enrichment.provider}</dd>
                  </>
                )}
                {enrichment.provider_release && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>Snapshot</dt>
                    <dd {...stylex.props(styles.metadataValue)}>{enrichment.provider_release}</dd>
                  </>
                )}
                {enrichment.computed_at && (
                  <>
                    <dt {...stylex.props(styles.metadataLabel)}>Computed</dt>
                    <dd {...stylex.props(styles.metadataValue)}>
                      {new Date(enrichment.computed_at).toLocaleDateString()}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {showPopulateMetadata && (
            <div {...stylex.props(styles.populateMetadataContainer)}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                xstyle={styles.populateMetadataButton}
                disabled={populateBusy}
                onClick={onPopulateMetadata}
              >
                {populateBusy ? (
                  <>
                    <Loader2 {...stylex.props([motionRecipe.spin, styles.populateMetadataSpinner])} />
                    Populating…
                  </>
                ) : (
                  "Populate metadata"
                )}
              </Button>
              {populateErr && <p {...stylex.props(styles.populateMetadataError)}>{populateErr}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
