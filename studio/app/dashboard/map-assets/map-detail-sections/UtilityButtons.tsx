"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { Check, Copy } from "lucide-react";

/** Props for the UtilityButtons component. */
type UtilityButtonsProps = {
  assetId: string;
  bboxText: string;
  centerText: string;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
};

/** Render copy-to-clipboard buttons for map ID, bounding box, and center coordinates. */
export function UtilityButtons({
  assetId,
  bboxText,
  centerText,
  copiedKey,
  onCopy,
}: UtilityButtonsProps) {
  return (
    <section className={stylex.props(styles.s_523).className}>
      <button
        type="button"
        onClick={() => onCopy(assetId, "mapId")}
        className={stylex.props(styles.s_530).className}
      >
        {copiedKey === "mapId" ? <Check className={stylex.props(styles.s_714).className} /> : <Copy className={stylex.props(styles.s_927).className} />}
        Map ID
      </button>
      <button
        type="button"
        onClick={() => onCopy(bboxText, "bbox")}
        className={stylex.props(styles.s_530).className}
      >
        {copiedKey === "bbox" ? <Check className={stylex.props(styles.s_714).className} /> : <Copy className={stylex.props(styles.s_927).className} />}
        bbox
      </button>
      <button
        type="button"
        onClick={() => onCopy(centerText, "center")}
        className={stylex.props(styles.s_530).className}
      >
        {copiedKey === "center" ? <Check className={stylex.props(styles.s_714).className} /> : <Copy className={stylex.props(styles.s_927).className} />}
        center
      </button>
    </section>
  );
}
