import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  artifactsToggle: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s1_5,
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
    borderWidth: "1px",
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
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  artifactType: {
    fontWeight: 500,
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
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  artifactActionIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
