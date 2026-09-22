import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const slideInFromBottom2 = stylex.keyframes({
  from: { transform: "translate3d(0, 0.5rem, 0)" },
});

export const hovered = stylex.defineVars({
resizeDotColor: "hsl(var(--border))"
});

export const styles = stylex.create({
  mediaPanel: {
    animationName: slideInFromBottom2,
    animationDuration: "200ms",
    animationTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
    position: "absolute",
    bottom: "0.75rem",
    right: "0.75rem",
    zIndex: layers.sticky,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
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
    [hovered.resizeDotColor]: colors.border,
    ":hover": {
      [hovered.resizeDotColor]: "hsl(var(--muted-foreground) / 0.6)",
    },
  },
  resizeGrip: {
    width: "0.375rem",
    height: "0.375rem",
    backgroundColor: hovered.resizeDotColor,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  header: {
    display: "flex",
    height: "2rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: colors.border,
    paddingLeft: "1.25rem",
    paddingRight: space.s2,
  },
  title: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 500,
  },
  closeButton: {
    height: "1.5rem",
    width: "1.5rem",
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
