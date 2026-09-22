import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

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
    fontSize: "10px",
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
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    paddingInline: space.s1_5,
    paddingBlock: "1px",
    fontSize: "10px",
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
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  phaseTimingAvailable: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    paddingInline: space.s1_5,
    paddingBlock: "1px",
    fontSize: "10px",
    fontWeight: text.weightMedium,
    color: "#4ade80",
  },
  phaseTimingUnavailable: {
    display: "inline-flex",
    alignItems: "center",
    backgroundColor: colors.muted,
    paddingInline: space.s1_5,
    paddingBlock: "1px",
    fontSize: "10px",
    fontWeight: text.weightMedium,
    color: colors.mutedForeground,
  },
  providerAttribution: {
    marginTop: space.s1_5,
    fontSize: "10px",
    lineHeight: text.lineSnug,
    color: "hsl(var(--muted-foreground) / 0.8)",
  },
});
