import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  mapLayersToggle: {
    display: "flex",
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
  layerGroupsList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    marginTop: space.s2,
  },
  groupHeaderRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    backgroundColor: colors.fillFaint,
    paddingInline: space.s2_5,
    paddingBlock: space.s1_5,
  },
  groupExpandButton: {
    flexShrink: 0,
  },
  chevronMuted: {
    width: "0.75rem",
    height: "0.75rem",
    color: colors.mutedForeground,
  },
  groupTitle: {
    minWidth: 0,
    flex: "1 1 0%",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.ink,
  },
  loadingIndicator: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  partiallyEnabled: {
    opacity: 0.6,
  },
  groupItemsList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    marginLeft: space.s4,
  },
  layerLabel: {
    minWidth: 0,
    flex: "1 1 0%",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.ink,
  },
  laneModeToggleGroup: {
    display: "flex",
    flexShrink: 0,
    overflow: "hidden",
  },
  laneModeButton: {
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    fontSize: text.sizeMeta,
    fontWeight: text.weightMedium,
  },
  laneModeButtonActive: {
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
  },
  laneModeButtonIdle: {
    backgroundColor: colors.fillFaint,
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  layerRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    backgroundColor: colors.fillFaint,
    paddingInline: space.s2_5,
    paddingBlock: space.s1,
  },
  layerRowEmpty: {
    opacity: 0.4,
  },
  layerColorDot: {
    width: "0.5rem",
    height: "0.5rem",
    flexShrink: 0,
  },
  layerCount: {
    flexShrink: 0,
    fontFamily: text.fontMono,
    fontSize: text.sizeMeta,
    color: colors.mutedForeground,
  },
  compactLayerRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    backgroundColor: colors.fillFaint,
    paddingInline: space.s2_5,
    paddingBlock: space.s1,
  },
  dotInHouseSpeedLimits: { backgroundColor: "#111111" },
  enrichmentEmptyState: {
    borderWidth: stroke.hairline,
    borderStyle: "dashed",
    borderColor: colors.hairline,
    paddingInline: space.s2_5,
    paddingBlock: space.s2_5,
  },
  enrichmentEmptyMessage: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
    marginBottom: space.s2,
  },
  enrichmentActionButton: {
    width: "100%",
  },
  enrichmentLoadingIcon: {
    marginRight: space.s1_5,
    width: "0.875rem",
    height: "0.875rem",
  },
  enrichmentActionIcon: {
    marginRight: space.s1_5,
    width: "0.875rem",
    height: "0.875rem",
  },
  providerReleaseRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s1,
    color: colors.mutedForeground,
  },
  providerReleaseLabel: {
    fontFamily: text.fontMono,
    color: colors.inkFaint,
  },
  enrichmentGlyphDot: {
    display: "flex",
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  enrichmentGlyphIcon: {
    width: "0.625rem",
    height: "0.625rem",
  },
  dotOvertureSpeedLimits: { backgroundColor: "#2563eb" },
  dotScenarioCandidate: { backgroundColor: "#f97316" },
  twinMetadataRow: {
    paddingInline: space.s1,
    color: colors.mutedForeground,
  },
  twinReferenceVersion: {
    marginLeft: space.s1,
    fontFamily: text.fontMono,
    color: colors.inkFaint,
  },
  resolutionSelectorRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s1,
  },
  resolutionLabel: {
    color: colors.mutedForeground,
  },
  resolutionButton: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontSize: text.sizeMicro,
    fontFamily: text.fontMono,
  },
  resolutionButtonActive: {
    borderColor: colors.accentLine,
    backgroundColor: colors.accentWash,
    color: colors.text,
  },
  resolutionButtonIdle: {
    borderColor: colors.hairline,
    backgroundColor: colors.fillFaint,
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  twinFidelityLegend: {
    paddingInline: space.s1,
    fontSize: text.sizeMicro,
    color: colors.mutedForeground,
  },
});
