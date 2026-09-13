import type { CSSProperties } from "react";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-canvas.stylex";

interface FeatureHoverTooltipProps {
  /** Pointer-derived placement; the plate itself is in `map-canvas.stylex`. */
  style: CSSProperties;
  items: { id: number; summary: string }[];
}

/** Hover tooltip shown when the cursor is over GeoJSON/enrichment/signal features. */
export function FeatureHoverTooltip({ style, items }: FeatureHoverTooltipProps) {
  const uniqueItems = items.filter(
    (item, index, allItems) =>
      allItems.findIndex((candidate) => candidate.summary === item.summary) ===
      index,
  );
  const [primaryItem, ...secondaryItems] = uniqueItems;

  return (
    <div
      role="tooltip"
      data-testid="feature-hover-tooltip"
      {...stylex.props(styles.featureTooltip)}
      style={style}
    >
      {primaryItem ? (
        <div {...stylex.props(styles.featurePrimary)}>{primaryItem.summary}</div>
      ) : null}
      {secondaryItems.length > 0 ? (
        <ul {...stylex.props(styles.featureList)}>
          {secondaryItems.map((item) => (
            <li key={item.id} {...stylex.props(styles.featureItem)}>
              {item.summary}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
