import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

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
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.5)",
  },
  loadingPlaceholderIcon: {
    width: "2rem",
    height: "2rem",
    animationName: pulse,
    animationDuration: motion.durPulse,
    animationTimingFunction: motion.easePulse,
    animationIterationCount: "infinite",
    color: colors.mutedForeground,
  },
  loadingSpinner: {
    width: "1.5rem",
    height: "1.5rem",
    animationName: spin,
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
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
    gap: space.s4,
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
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  noAssetDescription: {
    marginTop: space.s1,
    maxWidth: "20rem",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  viewerErrorContainer: {
    display: "flex",
    height: "100%",
    width: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s3,
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
    lineHeight: text.lineXs,
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
