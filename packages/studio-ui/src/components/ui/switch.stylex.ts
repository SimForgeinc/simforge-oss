import * as stylex from "@stylexjs/stylex";
import { colors, shadows, stroke } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    width: "1.75rem",
    height: "1rem",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "transparent",
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.5 },
    backgroundColor: { default: colors.muted, "[data-state=checked]": colors.primary, "[data-state=unchecked]": colors.muted },
  },
  thumb: {
    pointerEvents: "none",
    display: "block",
    width: "0.75rem",
    height: "0.75rem",
    backgroundColor: colors.bg,
    boxShadow: shadows.elevationLg,
    transform: { default: "translateX(0.125rem)", "[data-state=checked]": "translateX(0.875rem)", "[data-state=unchecked]": "translateX(0.125rem)" },
  },
});
