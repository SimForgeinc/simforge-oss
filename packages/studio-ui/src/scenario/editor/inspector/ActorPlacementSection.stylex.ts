import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // grid grid-cols-2 gap-2
  gridCols2Gap2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
  },
  // text-muted-foreground
  muted: {
    color: colors.mutedForeground,
  },
  // flex gap-2
  flexGap2: {
    display: "flex",
    gap: space.md,
  },
  // flex-1
  fill: {
    flex: "1 1 0%",
  },
  /*
   * The section's old `space-y-3`. `space-y` is a `> * + *` sibling rule,
   * which StyleX cannot express — a style reaches only the element it is set
   * on. Every child here is already a block-level box carrying no vertical
   * margin, so a flex column with the same gap places them identically.
   */
  stackLg: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
});
