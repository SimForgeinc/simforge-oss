import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  // flex h-full min-h-0 flex-col
  flexColTall: {
    display: "flex",
    height: "100%",
    minHeight: "0px",
    flexDirection: "column",
  },
  // min-h-0 flex-1
  fillShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
  },
});
