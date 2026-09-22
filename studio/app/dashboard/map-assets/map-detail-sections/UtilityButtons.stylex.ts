import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  utilityButtonsContainer: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s2,
  },
  utilityCopyButton: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
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
});
