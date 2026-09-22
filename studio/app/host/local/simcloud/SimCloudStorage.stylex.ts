import * as stylex from "@stylexjs/stylex";
import { space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
export const styles = stylex.create({
  pane: { display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", gap: space.lg, minWidth: 0, minHeight: 0, overflow: "hidden" },
  lists: { display: "grid", gridTemplateRows: "repeat(4, minmax(0, 1fr))", gap: space.lg, minHeight: 0, "@media (min-width: 1024px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridTemplateRows: "repeat(2, minmax(0, 1fr))" } },
  select: {
    height: "2rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.14)",
    backgroundColor: "rgb(255 255 255 / 0.04)",
    paddingInline: "0.5rem",
    fontSize: "0.75rem",
    color: "#fff",
  },
  targetSelect: { maxWidth: "11rem" },
  rowBody: { display: "grid", gap: "0.125rem", minWidth: 0, flex: "1 1 12rem" },
  rowTitle: { fontSize: "0.8125rem" },
});
