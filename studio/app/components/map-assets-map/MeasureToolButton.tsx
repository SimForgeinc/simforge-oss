"use client";

import * as stylex from "@stylexjs/stylex";
import { Ruler } from "lucide-react";
import { C } from "./map-layer-constants";
import { styles } from "./map-canvas.stylex";

type MeasureToolButtonProps = { active: boolean; onToggle: () => void };
export default function MeasureToolButton({ active, onToggle }: MeasureToolButtonProps) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={active} aria-label="Measure distance"
      {...stylex.props(styles.control, styles.measureControl, styles.modeFollow)}
      style={{ background: active ? C.fg : `${C.bg}f2`, color: active ? C.bg : C.fg, border: `1px solid ${C.border}`, cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>
      <Ruler size={15} aria-hidden />
    </button>
  );
}
