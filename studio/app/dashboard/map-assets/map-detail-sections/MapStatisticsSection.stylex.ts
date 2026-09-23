import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

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
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  copyStatsButton: {
    flexShrink: 0,
    color: { default: colors.inkFaint, ":hover": colors.mutedForeground },
  },
  copiedCheckIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: colors.positive,
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
