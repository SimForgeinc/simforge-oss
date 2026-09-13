import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // relative h-full min-h-0
  relTallShrinkable: {
    position: "relative",
    height: "100%",
    minHeight: "0px",
  },

  // h-full min-h-editor-shell — `editor-shell` is the 38.75rem shell measure,
  // the same number `space.shellWidth` carries.
  placeholder: {
    height: "100%",
    minHeight: space.shellWidth,
  },
  // bg-transparent
  placeholderTransparent: {
    backgroundColor: "transparent",
  },
  // bg-background
  placeholderOpaque: {
    backgroundColor: colors.bg,
  },
});
