import * as stylex from "@stylexjs/stylex";
const SM = "@media (min-width: 640px)";
export const styles = stylex.create({
  root: { display: "flex", height: "100%", flexDirection: "column", overflowY: "auto" },
  content: { paddingInline: "1.25rem", paddingBlock: "1.25rem", [SM]: { paddingInline: "1.5rem" } },
});