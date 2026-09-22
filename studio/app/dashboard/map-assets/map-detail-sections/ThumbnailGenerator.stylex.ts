import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

export const styles = stylex.create({
  offscreenMapContainer: {
    pointerEvents: "none",
    position: "fixed",
    left: "-9999px",
    top: "-9999px",
  },
  thumbnailCanvas: { width: "512px", height: "512px" },
  thumbnailGenerator: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  thumbnailControls: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
  },
  generateThumbnailButton: {
    gap: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  loadingIcon: {
    width: "0.75rem",
    height: "0.75rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  thumbnailIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  progressStatus: {
    fontSize: "10px",
    color: colors.mutedForeground,
  },
  errorMessage: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    fontSize: "10px",
    color: colors.danger,
  },
});
