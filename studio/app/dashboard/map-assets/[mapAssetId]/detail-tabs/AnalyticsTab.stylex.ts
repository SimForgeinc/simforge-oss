import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

export const styles = stylex.create({
  loadingState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: space.s12,
  },
  loadingSpinner: {
    width: "1.25rem",
    height: "1.25rem",
    color: colors.mutedForeground,
    animationName: spin,
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
  },
  loadingMessage: {
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
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: space.s12,
    textAlign: "center",
  },
  emptyStateIconWrapper: {
    display: "flex",
    height: "3rem",
    width: "3rem",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--muted) / 0.5)",
    marginBottom: space.s3,
  },
  emptyStateIcon: {
    color: colors.mutedForeground,
  },
  emptyStateTitle: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  emptyStateDescription: {
    marginTop: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
    maxWidth: "240px",
  },
});
