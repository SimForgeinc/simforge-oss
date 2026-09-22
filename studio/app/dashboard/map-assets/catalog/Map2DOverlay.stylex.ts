import * as stylex from "@stylexjs/stylex";
import { colors, layers } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = stylex.keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });
const zoomIn = stylex.keyframes({ from: { opacity: 0, transform: "scale(0.95)" }, to: { opacity: 1, transform: "scale(1)" } });
const zoomOut = stylex.keyframes({ from: { opacity: 1, transform: "scale(1)" }, to: { opacity: 0, transform: "scale(0.95)" } });

export const styles = stylex.create({
  dialogOverlay: {
    animationName: { default: fadeIn, ':is([data-state="closed"])': fadeOut },
    animationDuration: "150ms",
    position: "fixed",
    inset: "0",
    zIndex: 40,
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    backdropFilter: "blur(4px)",
  },
  dialogContent: {
    animationName: { default: zoomIn, ':is([data-state="closed"])': zoomOut },
    animationDuration: "150ms",
    position: "fixed",
    left: { default: "0.75rem", "@media (min-width: 640px)": "1.25rem", "@media (min-width: 1024px)": "2rem" },
    right: { default: "0.75rem", "@media (min-width: 640px)": "1.25rem", "@media (min-width: 1024px)": "2rem" },
    bottom: { default: "0.75rem", "@media (min-width: 640px)": "1.25rem", "@media (min-width: 1024px)": "2rem" },
    top: "4.25rem",
    zIndex: layers.popover,
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.glassHover,
    backgroundColor: colors.bg,
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
    /*
     * `outline-none` is Tailwind's transparent 2px outline, not `outline:
     * none`: it suppresses the UA ring without erasing the control's outline
     * in forced-colours mode, where the transparent outline is repainted as a
     * visible one.
     */
    outlineWidth: "2px",
    outlineStyle: "solid",
    outlineColor: "transparent",
    outlineOffset: "2px",
  },
  dialogText: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
});
