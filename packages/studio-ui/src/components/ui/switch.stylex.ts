import * as stylex from "@stylexjs/stylex";
import { colors, radii } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    width: "1.75rem",
    height: "1rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radii.full,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineColor: { default: null, ":focus-visible": colors.ring },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.5 },
    backgroundColor: { default: colors.muted, "[data-state=checked]": colors.primary, "[data-state=unchecked]": colors.muted },
  },
  thumb: {
    pointerEvents: "none",
    display: "block",
    width: "0.75rem",
    height: "0.75rem",
    borderRadius: radii.full,
    backgroundColor: colors.bg,
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    transitionProperty: "transform",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transform: { default: "translateX(0.125rem)", "[data-state=checked]": "translateX(0.875rem)", "[data-state=unchecked]": "translateX(0.125rem)" },
  },
});
