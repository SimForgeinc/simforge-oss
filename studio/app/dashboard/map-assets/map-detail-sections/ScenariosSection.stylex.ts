import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  scenarioToggle: {
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
  editorLink: {
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
  },
  editorIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  editorTooltip: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  emptyState: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  scenarioList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    marginTop: space.s2,
  },
  scenarioItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    padding: space.s2,
  },
  scenarioDetails: {
    minWidth: 0,
  },
  scenarioLink: {
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    textDecorationLine: { default: null, ":hover": "underline" },
  },
  scenarioTimestamp: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
});
