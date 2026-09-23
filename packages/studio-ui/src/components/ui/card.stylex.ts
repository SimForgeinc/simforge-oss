import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  card: {
    backgroundColor: colors.fillFaint,
    color: colors.ink,
  },
  header: {
    display: "grid",
    gridAutoRows: "min-content",
    gridTemplateColumns: "1fr auto",
    alignItems: "start",
    columnGap: space.s3,
    rowGap: space.s1_5,
    padding: space.s5,
  },
  title: {
    gridColumnStart: 1,
    margin: 0,
    fontFamily: text.fontDisplay,
    fontSize: text.sizeBase,
    fontWeight: text.weightSemibold,
    lineHeight: text.lineBase,
    letterSpacing: text.trackingTight,
    color: colors.ink,
  },
  description: { gridColumnStart: 1, fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.inkMuted },
  action: { gridColumnStart: 2, gridRow: "span 2 / span 2", gridRowStart: 1, alignSelf: "start", justifySelf: "end" },
  content: { paddingInline: space.s5, paddingBottom: space.s3 },
  footer: { display: "flex", alignItems: "center", borderTopWidth: stroke.hairline, borderTopStyle: "solid", borderTopColor: colors.hairline, padding: space.s4, paddingInline: space.s5 },
});
