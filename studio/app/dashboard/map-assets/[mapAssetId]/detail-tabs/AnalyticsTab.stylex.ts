import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

export const styles = stylex.create({
  loadingState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: "3rem",
  },
  loadingSpinner: {
    width: "1.25rem",
    height: "1.25rem",
    color: colors.mutedForeground,
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
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
    paddingBlock: "3rem",
    textAlign: "center",
  },
  emptyStateIconWrapper: {
    display: "flex",
    height: "3rem",
    width: "3rem",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--muted) / 0.5)",
    marginBottom: space.lg,
  },
  emptyStateIcon: {
    color: colors.mutedForeground,
  },
  emptyStateTitle: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: 500,
    color: colors.text,
  },
  emptyStateDescription: {
    marginTop: space.xs,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
    maxWidth: "240px",
  },
});
