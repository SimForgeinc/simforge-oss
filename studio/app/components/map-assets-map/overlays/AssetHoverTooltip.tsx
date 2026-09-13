import type { CSSProperties } from "react";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-canvas.stylex";

interface AssetHoverTooltipProps {
  /** Pointer-derived placement; the plate itself is in `map-canvas.stylex`. */
  style: CSSProperties;
  hoverInfo: { count: number; name?: string };
}

/** Hover tooltip shown when the cursor is over an asset cluster or single asset pin. */
export function AssetHoverTooltip({ style, hoverInfo }: AssetHoverTooltipProps) {
  return (
    <div role="tooltip" {...stylex.props(styles.assetTooltip)} style={style}>
      {hoverInfo.name ? (
        <>
          {hoverInfo.name} -{" "}
          <span {...stylex.props(styles.tooltipText)}>click to select</span>
        </>
      ) : (
        <>
          {hoverInfo.count} assets here -{" "}
          <span {...stylex.props(styles.tooltipText)}>click to select</span>
        </>
      )}
    </div>
  );
}
