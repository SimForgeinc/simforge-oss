import * as stylex from "@stylexjs/stylex";

/** The property list Tailwind's `transition-colors` compiles to. */
const TRANSITION_COLORS =
  "color, background-color, border-color, text-decoration-color, fill, stroke";

export const styles = stylex.create({
  alertIcon: { width: "1.25rem", height: "1.25rem" },
  reload: { marginTop: "1.5rem", height: "2.5rem", borderRadius: "9999px", backgroundColor: "#E8E044", paddingInline: "1.25rem", color: "black", ":hover": { backgroundColor: "#f1ea55" } },
  /**
   * `!z-[250] transition-colors ease-out motion-reduce:transition-none`
   *
   * The overlay sits one step above `CloudLoadingSurface`'s own `screen`
   * scope (240). It travels as `xstyle` so StyleX resolves the two `z-index`
   * rules by argument order; as a class name the `!important` was load-
   * bearing, and here it is not needed at all. `transition-duration` is
   * Tailwind's default — the caller's inline style raises it to 900ms.
   */
  overlay: {
    zIndex: 250,
    transitionProperty: {
      default: TRANSITION_COLORS,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transitionDuration: "150ms",
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
