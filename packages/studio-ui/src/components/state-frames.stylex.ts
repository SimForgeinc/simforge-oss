import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, text } from "../stylex/tokens.stylex";
export const styles = stylex.create({
  root: { display: "grid", placeItems: "center", minWidth: 0, minHeight: 0, width: "100%", padding: layout.gutterNarrow, overflowY: "auto", color: colors.text },
  route: { height: "100%", padding: { default: layout.gutterNarrow, [layout.bpLg]: layout.gutterWide } },
  content: { display: "grid", gap: space.s4, width: "100%", maxWidth: layout.formMeasure },
  title: { fontFamily: text.fontDisplay, fontSize: text.sizeXl, fontWeight: 600 },
  description: { fontSize: text.sizeSm, color: colors.mutedForeground, overflowWrap: "anywhere" },
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2 },
  details: { minWidth: 0, fontSize: text.sizeSm, color: colors.mutedForeground },
  diagnostic: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: text.fontMono, paddingBlock: space.s2 },
});
