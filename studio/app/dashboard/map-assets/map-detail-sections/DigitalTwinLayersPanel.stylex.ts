import * as stylex from "@stylexjs/stylex";
import { colors, shadows, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
  },
  qualityLabel: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
  },
  qualityOptions: {
    display: "flex",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.3)",
    padding: space.s0_5,
  },
  stackY1_5: { marginTop: { default: space.s1_5, ":first-child": 0 } },
  qualitySegment: {
    flex: "1 1 0%",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  qualitySegmentActive: {
    backgroundColor: colors.bg,
    fontWeight: text.weightMedium,
    color: colors.text,
    boxShadow: shadows.elevationSm,
  },
  qualitySegmentInactive: {
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  qualityDescription: {
    fontSize: "11px",
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  layerStatusList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "hsl(var(--border) / 0.7)",
    padding: space.s2_5,
  },
  clearCacheButton: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1_5,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    backgroundColor: { default: null, ":hover": colors.muted },
    opacity: { default: null, ":disabled": 0.5 },
  },
  clearCacheIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  layerStatusRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.text,
  },
  layerIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: colors.mutedForeground,
  },
  layerLabel: {
    flex: "1 1 0%",
  },
  layerCheckIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: "#22c55e",
  },
});
