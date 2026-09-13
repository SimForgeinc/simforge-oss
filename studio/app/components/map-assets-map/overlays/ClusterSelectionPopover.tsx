import type { CSSProperties } from "react";
import * as stylex from "@stylexjs/stylex";
import type { MapAsset } from "@simforge-oss/studio-shared";
import { styles } from "../map-canvas.stylex";

interface ClusterSelectionPopoverProps {
  /** Click-derived placement; the plate itself is in `map-canvas.stylex`. */
  style: CSSProperties;
  assets: MapAsset[];
  onSelectAsset: (id: string) => void;
  onClose: () => void;
}

/** Popover shown when a cluster of overlapping assets is clicked, listing each asset for selection. */
export function ClusterSelectionPopover({
  style,
  assets,
  onSelectAsset,
  onClose,
}: ClusterSelectionPopoverProps) {
  return (
    <div
      role="dialog"
      aria-label="Select map asset"
      {...stylex.props(styles.clusterPopover)}
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div {...stylex.props(styles.popoverHeading)}>
        {assets.length} maps at this location
      </div>
      <ul {...stylex.props(styles.popoverList)}>
        {assets.map((asset) => (
          <li key={asset.map_asset_id} {...stylex.props(styles.popoverItem)}>
            <button
              type="button"
              onClick={() => onSelectAsset(asset.map_asset_id)}
              {...stylex.props(styles.popoverAsset)}
            >
              {asset.name}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClose}
        {...stylex.props(styles.popoverClose)}
      >
        Close
      </button>
    </div>
  );
}
