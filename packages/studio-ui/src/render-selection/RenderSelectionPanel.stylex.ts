import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "../stylex/tokens.stylex";

const WIDE = "@media (min-width: 1024px)";
export const styles = stylex.create({
  page: { minWidth: 0, minHeight: 0, width: "100%", overflow: "hidden" },
  content: { display: "grid", gap: space.s4, minWidth: 0, minHeight: 0, color: colors.ink },
  header: { display: "grid", gap: space.s1 },
  title: { fontSize: text.sizeXl, lineHeight: text.lineTight, fontWeight: text.weightSemibold },
  lede: { fontSize: text.sizeSm, lineHeight: text.lineNormal, color: colors.textSubtle, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
  choices: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.s2, minWidth: 0, [WIDE]: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" } },
  withCache: { [WIDE]: { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" } },
  choice: {
    display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "center", gap: space.s2,
    minWidth: 0, minHeight: "8rem", textAlign: "left", padding: space.s3,
    borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.hairlineStrong, backgroundColor: colors.fillSubtle,
    color: colors.ink, cursor: "pointer", transitionProperty: "background-color, border-color", transitionDuration: motion.durFast,
    ":hover": { backgroundColor: colors.fillStronger },
    ":focus-visible": { outlineWidth: stroke.thick, outlineStyle: "solid", outlineColor: colors.accent, outlineOffset: -2 },
  },
  choiceCurrent: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  choiceLabel: { fontSize: text.sizeSm, lineHeight: text.lineTight, fontWeight: text.weightSemibold },
  choiceCopy: { fontSize: text.sizeXs, lineHeight: text.lineNormal, color: colors.textSubtle, minWidth: 0 },
  choiceTag: { fontFamily: text.fontMeta, fontSize: text.sizeXs, color: colors.accent },
  cache: { minWidth: 0, borderWidth: stroke.hairline, borderStyle: "solid", borderColor: colors.hairlineStrong, padding: space.s3, backgroundColor: colors.fillSubtle },
});
