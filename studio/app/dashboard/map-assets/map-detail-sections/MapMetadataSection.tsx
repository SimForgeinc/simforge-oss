"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { ChevronRight, Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";

import { cn } from "@simforge-oss/studio-ui/lib/utils";
import type { MapAsset, MapAssetEnrichmentSnapshot } from "@simforge-oss/studio-shared";

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
      <div className={stylex.props(styles.s_961).className}>
        <button
          type="button"
          onClick={onToggleOpen}
          className={stylex.props(styles.s_962).className}
          aria-expanded={open}
        >
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
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
            className={stylex.props(styles.s_713).className}
          >
            {copiedKey === "mapMetadata" ? (
              <Check className={stylex.props(styles.s_714).className} />
            ) : (
              <Copy className={stylex.props(styles.s_927).className} />
            )}
          </button>
        )}
      </div>
      {open && (
        <div className={stylex.props(styles.s_663).className}>
          {!hasExtractedMetadata && (
            <p className={stylex.props(styles.s_664).className}>
              No extracted fields yet. Upload geojson, xodr, and rrdata_xml for this map, then run{" "}
              <span className={stylex.props(styles.s_665).className}>Populate metadata</span> below (or create a new map with all
              three files).
            </p>
          )}
          {asset.place_context && (
            <div>
              <h4 className={stylex.props(styles.s_699).className}>
                Location
              </h4>
              <p className={stylex.props(styles.s_667).className}>
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
              <h4 className={stylex.props(styles.s_699).className}>
                Map source
              </h4>
              <dl className={stylex.props(styles.s_700).className}>
                {asset.map_source.tool != null && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>Tool</dt>
                    <dd className={stylex.props(styles.s_706).className}>{asset.map_source.tool}</dd>
                  </>
                )}
                {asset.map_source.tool_version != null && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>Version</dt>
                    <dd className={stylex.props(styles.s_697).className}>{asset.map_source.tool_version}</dd>
                  </>
                )}
                {asset.map_source.vendor != null && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>Vendor</dt>
                    <dd className={stylex.props(styles.s_706).className}>{asset.map_source.vendor}</dd>
                  </>
                )}
                {asset.map_source.opendrive_version != null && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>OpenDRIVE</dt>
                    <dd className={stylex.props(styles.s_706).className}>{asset.map_source.opendrive_version}</dd>
                  </>
                )}
                {asset.map_source.rrdata_schema_version != null && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>RR schema</dt>
                    <dd className={stylex.props(styles.s_706).className}>{asset.map_source.rrdata_schema_version}</dd>
                  </>
                )}
                {asset.map_source.exported_at != null && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>Exported</dt>
                    <dd className={stylex.props(styles.s_697).className}>{asset.map_source.exported_at}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {asset.map_coordinate_ref && (
            <div>
              <h4 className={stylex.props(styles.s_699).className}>
                Coordinate reference
              </h4>
              <dl className={stylex.props(styles.s_700).className}>
                {asset.map_coordinate_ref.origin_lat != null &&
                  asset.map_coordinate_ref.origin_lon != null && (
                    <>
                      <dt className={stylex.props(styles.s_705).className}>Origin</dt>
                      <dd className={stylex.props(styles.s_706).className}>
                        {asset.map_coordinate_ref.origin_lat.toFixed(6)},{" "}
                        {asset.map_coordinate_ref.origin_lon.toFixed(6)}
                      </dd>
                    </>
                  )}
                {asset.map_coordinate_ref.utm_zone != null && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>UTM</dt>
                    <dd className={stylex.props(styles.s_706).className}>{asset.map_coordinate_ref.utm_zone}</dd>
                  </>
                )}
                {asset.map_coordinate_ref.editor_offset_m != null && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>Editor offset</dt>
                    <dd className={stylex.props(styles.s_706).className}>
                      {asset.map_coordinate_ref.editor_offset_m.x.toFixed(2)},{" "}
                      {asset.map_coordinate_ref.editor_offset_m.y.toFixed(2)} m
                    </dd>
                  </>
                )}
                {asset.map_coordinate_ref.projection_type != null && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>Projection</dt>
                    <dd className={stylex.props(styles.s_706).className}>{asset.map_coordinate_ref.projection_type}</dd>
                  </>
                )}
                {asset.map_coordinate_ref.proj_string != null && (
                  <>
                    <dt className={stylex.props(styles.s_692).className}>PROJ</dt>
                    <dd className={stylex.props(styles.s_693).className}>
                      {asset.map_coordinate_ref.proj_string}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {asset.carla_map_name && (
            <div>
              <h4 className={stylex.props(styles.s_699).className}>
                CARLA Metadata
              </h4>
              <dl className={stylex.props(styles.s_700).className}>
                <dt className={stylex.props(styles.s_705).className}>Carla Map Name</dt>
                <dd className={stylex.props(styles.s_697).className}>{asset.carla_map_name}</dd>
              </dl>
            </div>
          )}
          {asset.metadata_last_populated_at && (
            <p className={stylex.props(styles.s_698).className}>
              Metadata last computed {new Date(asset.metadata_last_populated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </p>
          )}
          {enrichment && (
            <div>
              <h4 className={stylex.props(styles.s_699).className}>
                Third-Party Enrichment Source
              </h4>
              <dl className={stylex.props(styles.s_700).className}>
                {enrichment.provider && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>Provider</dt>
                    <dd className={stylex.props(styles.s_706).className}>{enrichment.provider}</dd>
                  </>
                )}
                {enrichment.provider_release && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>Snapshot</dt>
                    <dd className={stylex.props(styles.s_706).className}>{enrichment.provider_release}</dd>
                  </>
                )}
                {enrichment.computed_at && (
                  <>
                    <dt className={stylex.props(styles.s_705).className}>Computed</dt>
                    <dd className={stylex.props(styles.s_706).className}>
                      {new Date(enrichment.computed_at).toLocaleDateString()}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {showPopulateMetadata && (
            <div className={stylex.props(styles.s_707).className}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={stylex.props(styles.s_708).className}
                disabled={populateBusy}
                onClick={onPopulateMetadata}
              >
                {populateBusy ? (
                  <>
                    <Loader2 className={stylex.props(styles.s_709).className} />
                    Populating…
                  </>
                ) : (
                  "Populate metadata"
                )}
              </Button>
              {populateErr && <p className={stylex.props(styles.s_710).className}>{populateErr}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
