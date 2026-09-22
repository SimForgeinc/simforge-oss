import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

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
    gap: space.s2,
  },
  thumbnailControls: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  generateThumbnailButton: {
    gap: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  loadingIcon: {
    width: "0.75rem",
    height: "0.75rem",
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
    gap: space.s1,
    fontSize: "10px",
    color: colors.danger,
  },
});
