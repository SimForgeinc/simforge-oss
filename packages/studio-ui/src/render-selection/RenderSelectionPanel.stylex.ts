import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, text } from "../stylex/tokens.stylex";

const WIDE = "@media (min-width: 1024px)";
export const styles = stylex.create({
  page: { minWidth: 0, minHeight: 0, width: "100%", overflow: "hidden" },
  content: { display: "grid", gap: space.xl, minWidth: 0, minHeight: 0, color: colors.textOnPlate },
  header: { display: "grid", gap: space.xs },
  title: { fontSize: text.sizeXl, lineHeight: text.lineTight, fontWeight: text.weightSemibold },
  lede: { fontSize: text.sizeSm, lineHeight: text.lineNormal, color: colors.textSubtle, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
  choices: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.md, minWidth: 0, [WIDE]: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" } },
  withCache: { [WIDE]: { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" } },
  choice: {
    display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "center", gap: space.md,
    minWidth: 0, minHeight: "8rem", textAlign: "left", padding: space.lg,
    borderWidth: 1, borderStyle: "solid", borderColor: colors.lineStrong, backgroundColor: colors.glass,
    color: colors.textOnPlate, cursor: "pointer", transitionProperty: "background-color, border-color", transitionDuration: motion.durFast,
    ":hover": { backgroundColor: colors.glassHover },
    ":focus-visible": { outlineWidth: 2, outlineStyle: "solid", outlineColor: colors.accent, outlineOffset: -2 },
  },
  choiceCurrent: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  choiceLabel: { fontSize: text.sizeSm, lineHeight: text.lineTight, fontWeight: text.weightSemibold },
  choiceCopy: { fontSize: text.sizeXs, color: colors.textSubtle, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
  choiceTag: { fontFamily: text.fontMeta, fontSize: text.sizeXs, color: colors.accent },
  cache: { minWidth: 0, borderWidth: 1, borderStyle: "solid", borderColor: colors.lineStrong, padding: space.lg, backgroundColor: colors.glass },
});
