import type { CSSProperties } from "react";
import * as stylex from "@stylexjs/stylex";
import type { MapAsset } from "@simforge-oss/studio-shared";
import { C } from "../map-layer-constants";
import { styles } from "../map-canvas.stylex";
interface ClusterSelectionPopoverProps { style: CSSProperties; assets: MapAsset[]; onSelectAsset: (id: string) => void; onClose: () => void; }
export function ClusterSelectionPopover({ style, assets, onSelectAsset, onClose }: ClusterSelectionPopoverProps) {
  return <div role="dialog" aria-label="Select map asset" style={style} onMouseDown={(e) => e.stopPropagation()}>
    <div {...stylex.props(styles.popoverHeading)} style={{ color: C.muted }}>{assets.length} maps at this location</div>
    <ul {...stylex.props(styles.popoverList)}>{assets.map((asset) => <li key={asset.map_asset_id} {...stylex.props(styles.popoverItem)}>
      <button type="button" onClick={() => onSelectAsset(asset.map_asset_id)} {...stylex.props(styles.popoverAsset)} style={{ borderColor: C.border, color: C.fg, fontFamily: C.font }}>{asset.name}</button>
    </li>)}</ul>
    <button type="button" onClick={onClose} {...stylex.props(styles.popoverClose)} style={{ color: C.muted, fontFamily: C.font }}>Close</button>
  </div>;
}
