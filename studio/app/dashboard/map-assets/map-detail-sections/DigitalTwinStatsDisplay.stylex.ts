import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  collapsibleSectionToggle: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s1_5,
    paddingBottom: space.s1_5,
  },
  chevronMutedShrink: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  sectionIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: colors.mutedForeground,
    flexShrink: 0,
  },
  sectionLabel: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
  },
  sectionContent: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    marginLeft: "18px",
  },
  statRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
    paddingBlock: space.s0_5,
  },
  statLabel: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  statValue: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    fontVariantNumeric: "tabular-nums",
    textAlign: "right",
  },
  statsContainer: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingTop: space.s1,
  },
  expansionControls: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  expandCollapseButton: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.sizeMicro,
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  expandCollapseIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  lodSummary: {
    marginTop: space.s2,
    marginBottom: space.s1,
  },
  lodSummaryTitle: {
    color: colors.inkFaint,
    marginBottom: space.s1_5,
  },
  lodSummaryRows: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
  },
  readinessSignals: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    paddingBlock: space.s1,
  },
  limitationsList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    paddingBlock: space.s1,
  },
  limitationItem: {
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  strengthStrong: {
    backgroundColor: colors.positiveWash,
    color: colors.positive,
    borderColor: colors.positive,
  },
  strengthModerate: {
    backgroundColor: colors.warningWash,
    color: colors.warning,
    borderColor: colors.warning,
  },
  strengthLimited: {
    backgroundColor: colors.muted,
    color: colors.mutedForeground,
    borderColor: colors.hairline,
  },
  readinessSignalHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    marginBottom: space.s0_5,
  },
  strengthBadge: {
    display: "inline-flex",
    alignItems: "center",
    paddingInline: space.s1_5,
    paddingBlock: "1px",
    fontSize: text.sizeMicro,
    fontWeight: text.weightMedium,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
  },
  readinessSignalLabel: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
  },
  readinessSignalDescription: {
    fontSize: text.sizeMeta,
    color: colors.mutedForeground,
    lineHeight: text.lineRelaxed,
    marginLeft: space.s0_5,
  },
});
