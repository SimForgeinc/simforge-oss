import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  statisticsHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  statisticsToggle: {
    display: "flex",
    flex: "1 1 0%",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingWide,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  copyStatsButton: {
    flexShrink: 0,
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": colors.mutedForeground },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
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
    marginTop: space.s2,
  },
  noStatisticsMessage: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
});
