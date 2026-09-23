"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./UtilityButtons.stylex";

import { Check, Copy } from "lucide-react";
import { hairline, motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

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
    <section {...stylex.props(styles.utilityButtonsContainer)}>
      <button
        type="button"
        onClick={() => onCopy(assetId, "mapId")}
        {...stylex.props([motionRecipe.colors, [hairline.all, styles.utilityCopyButton]])}
      >
        {copiedKey === "mapId" ? <Check {...stylex.props(styles.copiedCheckIcon)} /> : <Copy {...stylex.props(styles.copyIcon)} />}
        Map ID
      </button>
      <button
        type="button"
        onClick={() => onCopy(bboxText, "bbox")}
        {...stylex.props([motionRecipe.colors, [hairline.all, styles.utilityCopyButton]])}
      >
        {copiedKey === "bbox" ? <Check {...stylex.props(styles.copiedCheckIcon)} /> : <Copy {...stylex.props(styles.copyIcon)} />}
        bbox
      </button>
      <button
        type="button"
        onClick={() => onCopy(centerText, "center")}
        {...stylex.props([motionRecipe.colors, [hairline.all, styles.utilityCopyButton]])}
      >
        {copiedKey === "center" ? <Check {...stylex.props(styles.copiedCheckIcon)} /> : <Copy {...stylex.props(styles.copyIcon)} />}
        center
      </button>
    </section>
  );
}
