import * as stylex from "@stylexjs/stylex";
import { colors } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  /**
   * `rounded-md` is intentionally absent: the global sharp-corner reset in
   * `styles.css` (`*, *::before, *::after { border-radius: 0 !important }`)
   * makes every radius inert, so the utility contributed nothing to render.
   */
  base: {
    backgroundColor: colors.muted,
  },
});
