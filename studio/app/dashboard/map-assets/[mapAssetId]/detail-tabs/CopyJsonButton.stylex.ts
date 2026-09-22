import * as stylex from "@stylexjs/stylex";
import { colors, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  copyJsonButton: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xs,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.4)" },
    opacity: { default: null, ":disabled": 0.4 },
    pointerEvents: { default: null, ":disabled": "none" },
  },
  copiedCheckIcon: {
    width: "0.875rem",
    height: "0.875rem",
    color: "#4ade80",
  },
  copyIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
