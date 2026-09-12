"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import type { MapAsset } from "@simforge-oss/studio-shared";
import { MapCard } from "./MapCard";

interface MapCardGridProps {
  assets: MapAsset[];
}

export function MapCardGrid({ assets }: MapCardGridProps) {
  return (
    <div className={stylex.props(styles.s_196).className}>
      {assets.map((asset) => (
        <MapCard key={asset.map_asset_id} asset={asset} />
      ))}
    </div>
  );
}
