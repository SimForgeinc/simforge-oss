import * as stylex from "@stylexjs/stylex";
import { colors, layers, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  errorCover: { position: "absolute", inset: 0, zIndex: layers.editorChrome },
  // size-5
  size5: {
    width: "1.25rem",
    height: "1.25rem",
  },
  // mt-6 h-10 rounded-full bg-[#E8E044] px-5 text-black hover:bg-[#f1ea55]
  round: {
    marginTop: space.s6,
    height: "2.5rem",
    borderRadius: "0",
    backgroundColor: {
      default: colors.accent,
      ":hover": colors.accentHover,
    },
    paddingLeft: space.s5,
    paddingRight: space.s5,
    color: "rgb(0 0 0 / 1)",
  },
});
