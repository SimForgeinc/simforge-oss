import * as stylex from "@stylexjs/stylex";
import { colors, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  copyJsonButton: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: space.s1,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    backgroundColor: { default: null, ":hover": colors.fillSubtle },
    opacity: { default: null, ":disabled": 0.4 },
    pointerEvents: { default: null, ":disabled": "none" },
  },
  copiedCheckIcon: {
    width: "0.875rem",
    height: "0.875rem",
    color: colors.positive,
  },
  copyIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
