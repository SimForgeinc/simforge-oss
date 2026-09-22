import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
export const styles = stylex.create({
  pane: { display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", gap: space.s3, minWidth: 0, minHeight: 0, overflow: "hidden" },
  lists: { display: "grid", gridTemplateRows: "repeat(4, minmax(0, 1fr))", gap: space.s3, minHeight: 0, "@media (min-width: 1024px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridTemplateRows: "repeat(2, minmax(0, 1fr))" } },
  select: {
    height: "2rem",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.hairlineStrong,
    backgroundColor: colors.fillSubtle,
    paddingInline: space.s2,
    fontSize: text.sizeXs,
    color: colors.ink,
  },
  targetSelect: { maxWidth: "11rem" },
  rowBody: { display: "grid", gap: space.s0_5, minWidth: 0, flex: "1 1 12rem" },
  rowTitle: { fontSize: "0.8125rem" },
});
