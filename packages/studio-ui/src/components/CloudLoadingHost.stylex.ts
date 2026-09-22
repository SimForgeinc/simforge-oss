import * as stylex from "@stylexjs/stylex";
import { colors, layers, radii } from "../stylex/tokens.stylex";

/** The property list Tailwind's `transition-colors` compiles to. */
const TRANSITION_COLORS =
  "color, background-color, border-color, text-decoration-color, fill, stroke";

export const styles = stylex.create({
  alertIcon: { width: "1.25rem", height: "1.25rem" },
  reload: { marginTop: "1.5rem", height: "2.5rem", borderRadius: radii.none, backgroundColor: colors.accent, paddingInline: "1.25rem", color: colors.accentText, ":hover": { backgroundColor: colors.accentHover } },
  /** The dashboard host covers content, never its escape/navigation chrome. */
  overlay: {
    top: "3.5rem",
    minHeight: 0,
    zIndex: layers.loadingTop,
    transitionProperty: {
      default: TRANSITION_COLORS,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transitionDuration: "900ms",
    transitionTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
  },
  /** `pointer-events-auto bg-black/70 backdrop-blur-2xl` */
  overlayVisible: {
    pointerEvents: "auto",
    backgroundColor: "rgb(0 0 0 / 0.7)",
    backdropFilter: "blur(40px)",
  },
  /** `pointer-events-none bg-transparent backdrop-blur-none` */
  overlayHidden: {
    pointerEvents: "none",
    backgroundColor: "transparent",
    backdropFilter: "none",
  },
});
