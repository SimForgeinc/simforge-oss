import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  statisticsHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
  },
  statisticsToggle: {
    display: "flex",
    flex: "1 1 0%",
    alignItems: "center",
    gap: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  copyStatsButton: {
    flexShrink: 0,
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": colors.mutedForeground },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  copiedCheckIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: "#4ade80",
  },
  copyStatsIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  statisticsContent: {
    marginTop: space.md,
  },
  noStatisticsMessage: {
    marginTop: space.md,
    fontSize: text.sizeXs,
    lineHeight: 1.625,
    color: colors.mutedForeground,
  },
});
