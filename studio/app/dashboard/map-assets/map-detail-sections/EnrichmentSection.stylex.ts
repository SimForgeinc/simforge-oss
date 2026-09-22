import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  headerRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  sectionToggle: {
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
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  enrichIconButton: {
    display: "flex",
    width: "1.25rem",
    height: "1.25rem",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": "hsl(var(--foreground) / 0.3)" },
    color: { default: colors.mutedForeground, ":hover": colors.text },
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  enrichLoadingIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  enrichSparklesIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  enrichTooltip: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  contentPanel: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    marginTop: space.s2,
  },
  statusText: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  emptyStateText: {
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  stackY2: { marginTop: { default: space.s2, ":first-child": 0 } },
  enrichButton: {
    width: "100%",
  },
  buttonLoadingIcon: {
    marginRight: space.s1_5,
    width: "0.875rem",
    height: "0.875rem",
  },
  buttonSparklesIcon: {
    marginRight: space.s1_5,
    width: "0.875rem",
    height: "0.875rem",
  },
  emptyStateError: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
  },
  provenanceLabel: {
    color: "hsl(var(--foreground) / 0.8)",
  },
  loadedError: {
    marginTop: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
  },
  attributionText: {
    fontSize: "10px",
    lineHeight: text.lineSnug,
    color: colors.mutedForeground,
  },
});
