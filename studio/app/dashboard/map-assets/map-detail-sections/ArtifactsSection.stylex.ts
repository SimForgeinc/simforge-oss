import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  artifactsToggle: {
    display: "flex",
    width: "100%",
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
  artifactsContent: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    marginTop: space.s2,
  },
  artifactsList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  artifactItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
  },
  artifactInfo: {
    minWidth: 0,
    flex: "1 1 0%",
  },
  artifactTitle: {
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  artifactType: {
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  artifactMetadata: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: "10px",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  artifactActions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2,
  },
  artifactAction: {
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  artifactActionIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
