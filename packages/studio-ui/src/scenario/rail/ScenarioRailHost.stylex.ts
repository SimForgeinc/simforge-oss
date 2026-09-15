import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex h-full min-h-0
  divFlex: {
    display: "flex",
    height: "100%",
    minHeight: 0,
  },
  // w-[240px] shrink-0 overflow-y-auto border-r border-border p-2
  div: {
    width: "240px",
    flexShrink: 0,
    overflowY: "auto",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: colors.border,
    padding: space.md,
  },
});
