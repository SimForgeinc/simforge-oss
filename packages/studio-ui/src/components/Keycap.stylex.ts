import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  keycap: { borderWidth: 1, borderStyle: "solid", borderColor: colors.border, paddingInline: space.sm, paddingBlock: space.xxs, fontFamily: text.fontMono, color: colors.text },
});
