import * as stylex from "@stylexjs/stylex";
import { space } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  frame: { display: "flex", flexDirection: "column", gap: space.s3, height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" },
  chrome: { flexShrink: 0, minWidth: 0 },
  inventory: { display: "grid", gap: space.s3, flex: "1 1 0%", minHeight: 0, minWidth: 0, overflowY: "auto", overscrollBehavior: "contain" },
});
