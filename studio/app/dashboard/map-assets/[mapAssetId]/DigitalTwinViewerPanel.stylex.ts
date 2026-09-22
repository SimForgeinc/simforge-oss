import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

export const styles = stylex.create({
  viewerLoadingContainer: {
    display: "flex",
    height: "100%",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--background) / 0.5)",
  },
  emptyStateIconWrapper: {
    display: "flex",
    height: "4rem",
    width: "4rem",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.5)",
  },
  loadingPlaceholderIcon: {
    width: "2rem",
    height: "2rem",
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
    color: colors.mutedForeground,
  },
  loadingSpinner: {
    width: "1.5rem",
    height: "1.5rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    color: colors.mutedForeground,
  },
  noAssetStateContainer: {
    display: "flex",
    height: "100%",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xl,
    backgroundColor: "hsl(var(--background) / 0.5)",
  },
  noAssetIcon: {
    width: "2rem",
    height: "2rem",
    color: colors.mutedForeground,
  },
  noAssetTextContent: {
    textAlign: "center",
  },
  noAssetTitle: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 600,
    color: colors.text,
  },
  noAssetDescription: {
    marginTop: space.xs,
    maxWidth: "20rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  viewerErrorContainer: {
    display: "flex",
    height: "100%",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.lg,
    backgroundColor: "hsl(var(--background) / 0.5)",
  },
  viewerErrorIcon: {
    width: "1.75rem",
    height: "1.75rem",
    color: colors.danger,
  },
  viewerErrorMessage: {
    maxWidth: "28rem",
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  viewerHostContainer: {
    position: "absolute",
    inset: "0",
  },
  viewerCanvas: {
    height: "100%",
    width: "100%",
  },
});
