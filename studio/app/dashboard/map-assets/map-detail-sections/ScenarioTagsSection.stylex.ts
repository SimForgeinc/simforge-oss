import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  tagsHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
  },
  toggleButton: {
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
  copyButton: {
    flexShrink: 0,
    color: { default: "hsl(var(--muted-foreground) / 0.6)", ":hover": colors.mutedForeground },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  checkIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: "#4ade80",
  },
  copyIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  tagsList: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    marginTop: space.md,
  },
  tagItem: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.3)",
    paddingInline: "0.625rem",
    paddingBlock: space.md,
  },
  tagLabel: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 500,
    color: colors.text,
  },
  tagDefinition: {
    marginTop: space.xxs,
    fontSize: "11px",
    lineHeight: 1.375,
    color: colors.mutedForeground,
  },
});
