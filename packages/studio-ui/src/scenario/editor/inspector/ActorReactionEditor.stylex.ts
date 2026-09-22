import * as stylex from "@stylexjs/stylex";
import { space, stroke } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  /*
   * `mt-4`. The `space-y-3` that used to sit beside it never applied: this
   * editor has exactly one child, and `space-y` only styles a child that
   * follows a sibling.
   */
  mt4: {
    marginTop: space.s4,
  },
  // flex min-h-0 overflow-hidden border border-white/10
  flexBorderedClip: {
    display: "flex",
    minHeight: "0px",
    overflow: "hidden",
    borderWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.1)",
  },
});
