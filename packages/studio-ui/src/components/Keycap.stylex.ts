import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  keycap: { paddingInline: space.s1_5, paddingBlock: space.s0_5, fontFamily: text.fontMono, color: colors.text },
});
