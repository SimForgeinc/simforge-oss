import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  candidateCard: {
    width: "100%",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
    textAlign: "left",
  },
  candidateCardSelected: {
    borderColor: "rgba(251, 146, 60, 0.7)",
    backgroundColor: "rgba(249, 115, 22, 0.1)",
  },
  candidateCardIdle: {
    borderColor: colors.hairline,
    backgroundColor: { default: colors.fillFaint, ":hover": colors.fillSubtle },
  },
  candidateHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.s2,
  },
  candidateLabel: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  confidenceBadge: {
    flexShrink: 0,
    paddingInline: space.s1,
    paddingBlock: space.s0_5,
    fontSize: text.sizeMicro,
    fontWeight: text.weightMedium,
  },
  confidenceHigh: {
    backgroundColor: "rgba(2, 44, 34, 0.4)",
    color: colors.positive,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "rgba(4, 120, 87, 0.4)",
  },
  confidenceMedium: {
    backgroundColor: "rgba(23, 37, 84, 0.4)",
    color: colors.info,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "rgba(29, 78, 216, 0.4)",
  },
  confidenceLow: {
    backgroundColor: colors.muted,
    color: colors.mutedForeground,
  },
  candidateExplanation: {
    marginTop: space.s1,
    fontSize: text.sizeMicro,
    color: colors.inkFaint,
  },
  candidateTagsRow: {
    marginTop: space.s1_5,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s1,
  },
  familyChip: {
    backgroundColor: colors.fillSubtle,
    paddingInline: space.s2,
    paddingBlock: "1px",
    fontSize: text.sizeMicro,
    fontWeight: text.weightMedium,
    color: colors.mutedForeground,
  },
  tagChip: {
    backgroundColor: colors.fillSubtle,
    paddingInline: space.s1,
    paddingBlock: "1px",
    fontSize: text.sizeMicro,
    color: colors.mutedForeground,
  },
  tagOverflowChip: {
    paddingInline: space.s1,
    fontSize: text.sizeMicro,
    color: colors.inkFaint,
  },
  compactEvidence: {
    marginTop: space.s0_5,
    fontSize: text.sizeMicro,
    color: colors.inkFaint,
  },
  tooltipContent: {
    maxWidth: "20rem",
    whiteSpace: "pre-line",
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
  },
});
