import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

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
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingWide,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  copyMetadataButton: {
    flexShrink: 0,
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": colors.mutedForeground },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  copiedCheckIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: "#4ade80",
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
    color: "hsl(var(--foreground) / 0.8)",
  },
  metadataSubsectionHeading: {
    marginBottom: space.s1,
    fontSize: "11px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingWide,
    color: colors.mutedForeground,
  },
  locationValue: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: "hsl(var(--foreground) / 0.9)",
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
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  metadataValue: {
    fontFamily: text.fontMono,
    color: "hsl(var(--foreground) / 0.9)",
  },
  metadataSecondaryValue: {
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    color: "hsl(var(--foreground) / 0.9)",
  },
  projLabel: {
    color: "hsl(var(--muted-foreground) / 0.7)",
    flexShrink: 0,
  },
  projStringValue: {
    wordBreak: "break-all",
    fontFamily: text.fontMono,
    fontSize: "10px",
    lineHeight: text.lineSnug,
    color: "hsl(var(--foreground) / 0.85)",
  },
  metadataTimestamp: {
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.6)",
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
    animationName: spin,
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
  },
  populateMetadataError: {
    marginTop: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
  },
});
