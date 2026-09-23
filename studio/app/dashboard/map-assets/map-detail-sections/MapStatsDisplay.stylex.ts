import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  sectionToggle: {
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
  expandControls: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  expandAllButton: {
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
  speedLimitList: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1,
    justifyContent: "flex-end",
  },
  speedLimitValue: {
    display: "inline-flex",
    alignItems: "center",
    paddingInline: space.s1_5,
    paddingBlock: "1px",
    fontSize: text.sizeMicro,
    fontWeight: text.weightMedium,
  },
  crosswalkSourceDetail: {
    marginLeft: space.s1,
    color: colors.mutedForeground,
  },
  signalDetailRow: {
    marginLeft: space.s2,
  },
  signalDetailText: {
    fontSize: text.sizeMicro,
    color: colors.inkFaint,
  },
  phaseTimingAvailable: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: colors.positiveWash,
    paddingInline: space.s1_5,
    paddingBlock: "1px",
    fontSize: text.sizeMicro,
    fontWeight: text.weightMedium,
    color: colors.positive,
  },
  phaseTimingUnavailable: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: colors.muted,
    paddingInline: space.s1_5,
    paddingBlock: "1px",
    fontSize: text.sizeMicro,
    fontWeight: text.weightMedium,
    color: colors.mutedForeground,
  },
  providerAttribution: {
    marginTop: space.s1_5,
    fontSize: text.sizeMicro,
    lineHeight: text.lineSnug,
    color: colors.inkMuted,
  },
});
