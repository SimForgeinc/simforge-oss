"use client";

import * as stylex from "@stylexjs/stylex";
import { Ruler } from "lucide-react";
import { styles } from "./map-canvas.stylex";

type MeasureToolButtonProps = {
  active: boolean;
  onToggle: () => void;
};

/**
 * Toggle for the two-point distance-measure mode, pinned to the bottom-right
 * corner just above MapLibre's attribution control.
 */
export default function MeasureToolButton({ active, onToggle }: MeasureToolButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label="Measure distance"
      title={active ? "Exit measure mode (Esc)" : "Measure distance"}
      {...stylex.props(
        styles.control,
        styles.measureControl,
        active ? styles.measureActive : styles.measureInactive,
      )}
    >
      <Ruler size={15} aria-hidden />
    </button>
  );
}
