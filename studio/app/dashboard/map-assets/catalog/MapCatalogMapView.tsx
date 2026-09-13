"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { MapAsset } from "@simforge-oss/studio-shared";
import MapAssetsMapDynamic from "@/app/components/map-assets-map/MapAssetsMapDynamic";
import { getCardStats, getMapCapabilities, humanizeTag, rankDominantTags } from "./map-card-data";
import { CapabilityHints, CardStatsRow } from "./map-card-display";

interface MapCatalogMapViewProps {
  assets: MapAsset[];
}

// The map-view rail is narrow (320px), so show a tighter stat/tag set than the
// grid card while keeping the same capability hints and dominance ordering.
const MAX_RAIL_STATS = 5;
const MAX_RAIL_TAGS = 2;

export function MapCatalogMapView({ assets }: MapCatalogMapViewProps) {
  const router = useRouter();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className={stylex.props(styles.s_168).className}>
      {/* Left: compact list */}
      <div className={stylex.props(styles.s_169).className}>
        {assets.length === 0 ? (
          <p className={stylex.props(styles.s_170).className}>No maps found.</p>
        ) : (
          assets.map((asset) => {
            const stats = getCardStats(asset).slice(0, MAX_RAIL_STATS);
            const caps = getMapCapabilities(asset);
            const rankedTags = rankDominantTags(asset);
            const tags = rankedTags.slice(0, MAX_RAIL_TAGS);
            const remainingTags = rankedTags.length - MAX_RAIL_TAGS;
            const placeContext = asset.place_context;
            const locationStr = placeContext
              ? [placeContext.city, placeContext.state, placeContext.country_code?.toUpperCase()]
                  .filter(Boolean)
                  .join(", ")
              : null;

            return (
              <Link
                key={asset.map_asset_id}
                href={`/dashboard/map-assets/${asset.map_asset_id}`}
                className={stylex.props(styles.catalogRow, hoveredId === asset.map_asset_id && styles.catalogRowHovered).className}
                onMouseEnter={() => setHoveredId(asset.map_asset_id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <p className={stylex.props(styles.s_171).className}>{asset.name}</p>
                {locationStr && (
                  <p className={stylex.props(styles.s_172).className}>{locationStr}</p>
                )}
                <div className={stylex.props(styles.s_174).className}>
                  <CapabilityHints caps={caps} size="sm" />
                </div>
                <div className={stylex.props(styles.s_174).className}>
                  <CardStatsRow stats={stats} size="sm" />
                </div>
                {tags.length > 0 && (
                  <div className={stylex.props(styles.s_175).className}>
                    {tags.map((tagId) => (
                      <span
                        key={tagId}
                        className={stylex.props(styles.s_176).className}
                      >
                        {humanizeTag(tagId)}
                      </span>
                    ))}
                    {remainingTags > 0 && (
                      <span className={stylex.props(styles.s_177).className}>
                        +{remainingTags}
                      </span>
                    )}
                  </div>
                )}
              </Link>
            );
          })
        )}
      </div>

      {/* Right: MapLibre in catalog/cluster mode */}
      <div className={stylex.props(styles.s_792).className}>
        <div className={stylex.props(styles.s_801).className}>
          <MapAssetsMapDynamic
            assets={assets}
            selectedAssetId={null}
            onSelectAsset={(id) => {
              if (id) router.push(`/dashboard/map-assets/${id}`);
            }}
          />
        </div>
      </div>
    </div>
  );
}
