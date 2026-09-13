import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // size-4 text-emerald-400
  size4TextEmerald400: {
    width: "1rem",
    height: "1rem",
    color: "rgb(52 211 153 / 1)",
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // h-8 gap-2 rounded-none border border-border bg-card/90 px-3 shadow-sm backdrop-blur
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.md,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
  },
});
