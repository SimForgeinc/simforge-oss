import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  sectionHeaderRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  sectionToggleButton: {
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
  copyMetadataButton: {
    flexShrink: 0,
    color: { default: colors.inkFaint, ":hover": colors.mutedForeground },
  },
  copiedCheckIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: colors.positive,
  },
  copyIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  metadataContent: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    marginTop: space.s2,
  },
  emptyMetadataNotice: {
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  populateMetadataEmphasis: {
    color: colors.inkSecondary,
  },
  metadataSubsectionHeading: {
    marginBottom: space.s1,
    color: colors.mutedForeground,
  },
  locationValue: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.ink,
  },
  metadataDefinitionList: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: space.s2,
    rowGap: space.s0_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  metadataLabel: {
    color: colors.inkFaint,
  },
  metadataValue: {
    fontFamily: text.fontMono,
    color: colors.ink,
  },
  metadataSecondaryValue: {
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    color: colors.ink,
  },
  projLabel: {
    color: colors.inkFaint,
    flexShrink: 0,
  },
  projStringValue: {
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineSnug,
    color: colors.ink,
  },
  metadataTimestamp: {
    fontSize: text.sizeMicro,
    color: colors.inkFaint,
  },
  populateMetadataContainer: {
    paddingTop: space.s1,
  },
  populateMetadataButton: {
    width: "100%",
  },
  populateMetadataSpinner: {
    marginRight: space.s1_5,
    width: "0.875rem",
    height: "0.875rem",
  },
  populateMetadataError: {
    marginTop: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
  },
});
