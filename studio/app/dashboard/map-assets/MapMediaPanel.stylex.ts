import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const slideInFromBottom2 = stylex.keyframes({
  from: { transform: "translate3d(0, 0.5rem, 0)" },
});

export const hovered = stylex.defineVars({
resizeDotColor: "hsl(var(--border))"
});

export const styles = stylex.create({
  mediaPanel: {
    animationName: slideInFromBottom2,
    animationDuration: motion.durBase,
    animationTimingFunction: motion.easeDecelerate,
    position: "absolute",
    bottom: "0.75rem",
    right: "0.75rem",
    zIndex: layers.sticky,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: colors.bg,
    boxShadow: shadows.elevationXl,
  },
  resizeHandle: {
    position: "absolute",
    left: "0",
    top: "0",
    zIndex: layers.raised,
    display: "flex",
    width: "1rem",
    height: "1rem",
    cursor: "nwse-resize",
    alignItems: "center",
    justifyContent: "center",
    [hovered.resizeDotColor]: colors.hairline,
    ":hover": {
      [hovered.resizeDotColor]: "hsl(var(--muted-foreground) / 0.6)",
    },
  },
  resizeGrip: {
    width: "0.375rem",
    height: "0.375rem",
    backgroundColor: hovered.resizeDotColor,
  },
  header: {
    display: "flex",
    height: "2rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
    paddingLeft: space.s5,
    paddingRight: space.s2,
  },
  title: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
  },
  closeButton: {
    flexShrink: 0,
  },
  closeIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  videoContainer: {
    backgroundColor: "#000",
  },
  video: {
    height: "100%",
    width: "100%",
    objectFit: "contain",
  },
});
