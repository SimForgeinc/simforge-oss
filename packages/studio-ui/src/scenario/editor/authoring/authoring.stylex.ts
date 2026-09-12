import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  heading: { color: colors.textMuted, fontSize: text.sizeSm, fontWeight: text.weightSemibold, textTransform: "uppercase", letterSpacing: text.trackingMeta },
  row: { display: "flex", alignItems: "center" },
  item: { marginTop: space.md, backgroundColor: colors.glass, padding: space.md },
  itemBorder: { marginTop: space.md, border: `1px solid ${colors.border}`, backgroundColor: colors.glass, padding: space.md },
  monoInput: { marginTop: space.xs, height: "2rem", fontFamily: text.fontMono, fontSize: text.sizeMicro },
  stack: { marginTop: space.md, display: "flex", flexDirection: "column", gap: space.md },
  fieldWrap: { minWidth: 0 },
  label: { display: "block", color: colors.textMuted },
  input: { marginTop: space.xs, height: "2rem" },
  iconButton: { marginLeft: "auto", color: colors.primary, transition: "color 80ms ease" },
  iconButtonMuted: { marginLeft: "auto", color: colors.textMuted, transition: "color 80ms ease" },
  icon: { width: "0.75rem", height: "0.75rem" },
});
