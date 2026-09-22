import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    paddingBlock: space.s8,
    textAlign: "center",
    color: colors.mutedForeground,
  },
  emptyStateIcon: {
    width: "2rem",
    height: "2rem",
    opacity: 0.5,
  },
  emptyStateMessage: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  inspectorContainer: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  selectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectionTitle: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    color: colors.mutedForeground,
  },
  clearSelectionButton: {
    display: "flex",
    width: "1.25rem",
    height: "1.25rem",
    alignItems: "center",
    justifyContent: "center",
    color: { default: colors.mutedForeground, ":hover": colors.text },
    backgroundColor: { default: null, ":hover": colors.fillSubtle },
  },
  clearSelectionIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  featureList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  elementCard: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    textAlign: "left",
  },
  elementCardSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.accentWash,
  },
  elementCardIdle: {
    borderColor: colors.hairline,
    backgroundColor: { default: colors.fillFaint, ":hover": colors.fillSubtle },
  },
  featureToggleButton: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  chevronLg: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  featureSummary: {
    minWidth: 0,
  },
  expandedDetails: {
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderColor: colors.hairline,
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
  },
  featureActionRow: {
    marginBottom: space.s2,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
  },
  geometryLabel: {
    fontSize: text.sizeMeta,
    color: colors.mutedForeground,
  },
  detailValue: {
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  copyGeoJsonButton: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontSize: text.sizeMeta,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    backgroundColor: { default: null, ":hover": colors.fillSubtle },
  },
  copiedIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: colors.positive,
  },
  copyIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  streetFactsSection: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    marginBottom: space.s2,
  },
  streetFactsHeading: {
    color: colors.mutedForeground,
  },
  detailRow: {
    display: "flex",
    alignItems: "baseline",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  detailLabel: {
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  overtureSource: {
    marginLeft: space.s1,
    fontWeight: text.weightNormal,
    color: colors.mutedForeground,
  },
  sectionDivider: {
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
    paddingTop: space.s1,
  },
  identifierSection: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    marginBottom: space.s2,
  },
  identifierValue: {
    fontFamily: text.fontMono,
    color: colors.inkSecondary,
    fontSize: text.sizeMicro,
    wordBreak: "break-all",
  },
  propertiesHeading: {
    marginBottom: space.s1_5,
    color: colors.mutedForeground,
  },
});
