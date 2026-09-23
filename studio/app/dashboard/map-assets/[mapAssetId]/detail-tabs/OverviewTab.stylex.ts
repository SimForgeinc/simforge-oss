import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  quickStatCard: {
    padding: space.s3,
    backgroundColor: { default: "hsl(var(--secondary) / 0.5)", ":hover": "hsl(var(--secondary) / 0.7)" },
  },
  quickStatLabelRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    color: colors.mutedForeground,
    marginBottom: space.s2,
  },
  quickStatLabel: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
  },
  quickStatValue: {
    fontSize: text.sizeLg,
    lineHeight: text.lineLg,
    fontWeight: text.weightSemibold,
    color: colors.text,
    fontFamily: text.fontMono,
  },
  quickStatTooltip: {
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
  },
  overviewContainer: {
    display: "flex",
    flexDirection: "column",
    gap: space.s5,
  },
  assetHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.s2,
  },
  assetTitleBlock: {
    minWidth: 0,
  },
  assetTitle: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSnug,
    fontWeight: text.weightSemibold,
  },
  assetLocation: {
    marginTop: space.s0_5,
    fontSize: text.sizeMeta,
    color: colors.mutedForeground,
  },
  descriptionBlock: {
    marginTop: space.s1,
  },
  overviewDescription: {
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  clamp2: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  descriptionToggle: {
    marginTop: space.s0_5,
    fontSize: text.sizeMicro,
    color: { default: colors.inkFaint, ":hover": colors.mutedForeground },
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: space.s2,
  },
  sectionTitle: {
    color: colors.mutedForeground,
  },
  viewAllButton: {
    display: "flex",
    alignItems: "center",
    gap: space.s0_5,
    fontSize: text.sizeMicro,
    color: { default: colors.primary, ":hover": colors.accent },
  },
  viewAllChevron: {
    width: "0.75rem",
    height: "0.75rem",
  },
  quickStatsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.s2_5,
  },
  quickStatIcon: {
    width: "1rem",
    height: "1rem",
  },
  insightsStatsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1_5,
    marginBottom: space.s3,
  },
  locationCount: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    backgroundColor: colors.fillSubtle,
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    fontSize: text.sizeMicro,
    color: colors.mutedForeground,
  },
  loadingIcon: {
    width: "0.625rem",
    height: "0.625rem",
  },
  familyCount: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: colors.fillSubtle,
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    fontSize: text.sizeMicro,
    color: colors.mutedForeground,
  },
  confidenceCount: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "rgba(2, 44, 34, 0.4)",
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    fontSize: text.sizeMicro,
    color: colors.positive,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "rgba(4, 120, 87, 0.3)",
  },
  familyGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s2,
  },
  familyCard: {
    minWidth: 0,
    backgroundColor: { default: colors.fillFaint, ":hover": colors.fillSubtle },
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    textAlign: "left",
  },
  familyCardHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  familyIcon: {
    width: "0.875rem",
    height: "0.875rem",
    color: colors.primary,
    flexShrink: 0,
  },
  familyName: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  familySummary: {
    marginTop: space.s0_5,
    fontSize: text.sizeMicro,
    color: colors.inkFaint,
  },
  familyTooltip: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    maxWidth: "20rem",
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
  },
  tooltipLabel: {
    fontWeight: text.weightSemibold,
  },
  tooltipAction: {
    color: colors.mutedForeground,
  },
  expandFamiliesButton: {
    marginTop: space.s2,
    display: "flex",
    alignItems: "center",
    gap: space.s0_5,
    fontSize: text.sizeMicro,
    color: { default: colors.primary, ":hover": colors.accent },
  },
  chevronBare: {
    width: "0.75rem",
    height: "0.75rem",
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
});
