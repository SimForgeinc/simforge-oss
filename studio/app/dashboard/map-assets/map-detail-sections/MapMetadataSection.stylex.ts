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
    gap: space.xs,
  },
  sectionToggleButton: {
    display: "flex",
    flex: "1 1 0%",
    alignItems: "center",
    gap: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  copyMetadataButton: {
    flexShrink: 0,
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": colors.mutedForeground },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
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
    gap: space.lg,
    marginTop: space.md,
  },
  emptyMetadataNotice: {
    fontSize: text.sizeXs,
    lineHeight: 1.625,
    color: colors.mutedForeground,
  },
  populateMetadataEmphasis: {
    color: "hsl(var(--foreground) / 0.8)",
  },
  metadataSubsectionHeading: {
    marginBottom: space.xs,
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: colors.mutedForeground,
  },
  locationValue: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "hsl(var(--foreground) / 0.9)",
  },
  metadataDefinitionList: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: space.md,
    rowGap: space.xxs,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  metadataLabel: {
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  metadataValue: {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--foreground) / 0.9)",
  },
  metadataSecondaryValue: {
    wordBreak: "break-all",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    color: "hsl(var(--foreground) / 0.9)",
  },
  projLabel: {
    color: "hsl(var(--muted-foreground) / 0.7)",
    flexShrink: 0,
  },
  projStringValue: {
    wordBreak: "break-all",
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: "10px",
    lineHeight: 1.375,
    color: "hsl(var(--foreground) / 0.85)",
  },
  metadataTimestamp: {
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.6)",
  },
  populateMetadataContainer: {
    paddingTop: space.xs,
  },
  populateMetadataButton: {
    width: "100%",
  },
  populateMetadataSpinner: {
    marginRight: space.sm,
    width: "0.875rem",
    height: "0.875rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  populateMetadataError: {
    marginTop: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
});
