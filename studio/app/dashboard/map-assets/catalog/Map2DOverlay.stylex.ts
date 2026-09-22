import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, stroke } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = stylex.keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });
const zoomIn = stylex.keyframes({ from: { opacity: 0, transform: "scale(0.95)" }, to: { opacity: 1, transform: "scale(1)" } });
const zoomOut = stylex.keyframes({ from: { opacity: 1, transform: "scale(1)" }, to: { opacity: 0, transform: "scale(0.95)" } });

export const styles = stylex.create({
  dialogOverlay: {
    animationName: { default: fadeIn, ':is([data-state="closed"])': fadeOut },
    animationDuration: motion.durStandard,
    position: "fixed",
    inset: "0",
    zIndex: layers.overlay,
    backgroundColor: colors.scrimHeavy,
    backdropFilter: motion.blurSm,
  },
  dialogContent: {
    animationName: { default: zoomIn, ':is([data-state="closed"])': zoomOut },
    animationDuration: motion.durStandard,
    position: "fixed",
    left: { default: "0.75rem", "@media (min-width: 640px)": "1.25rem", "@media (min-width: 1024px)": "2rem" },
    right: { default: "0.75rem", "@media (min-width: 640px)": "1.25rem", "@media (min-width: 1024px)": "2rem" },
    bottom: { default: "0.75rem", "@media (min-width: 640px)": "1.25rem", "@media (min-width: 1024px)": "2rem" },
    top: "4.25rem",
    zIndex: layers.popover,
    overflow: "hidden",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.fillStronger,
    backgroundColor: colors.bg,
    boxShadow: shadows.elevation2xl,
    /*
     * `outline-none` is Tailwind's transparent 2px outline, not `outline:
     * none`: it suppresses the UA ring without erasing the control's outline
     * in forced-colours mode, where the transparent outline is repainted as a
     * visible one.
     */
    outlineWidth: stroke.thick,
    outlineStyle: "solid",
    outlineColor: "transparent",
    outlineOffset: "2px",
  },
});
