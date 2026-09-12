import type { CSSProperties } from "react";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-canvas.stylex";
export function AssetHoverTooltip({ style, hoverInfo }: { style: CSSProperties; hoverInfo: { name?: string; count: number } }) {
  return <div role="tooltip" style={style}>{hoverInfo.name ? <>{hoverInfo.name} - <span {...stylex.props(styles.tooltipText)}>click to select</span></> : <>{hoverInfo.count} assets here - <span {...stylex.props(styles.tooltipText)}>click to select</span></>}</div>;
}
