import * as stylex from "@stylexjs/stylex";
import { space } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  frame: { display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", gap: space.s3, minWidth: 0, minHeight: 0, height: "100%", overflow: "hidden" },
  catalog: { minWidth: 0, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" },
  grid: {
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17rem), 1fr))",
    gridAutoRows: "10rem",
    height: "auto",
    overflowY: "visible",
  },
});
