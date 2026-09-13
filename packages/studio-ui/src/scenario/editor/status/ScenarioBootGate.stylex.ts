import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // size-5
  size5: {
    width: "1.25rem",
    height: "1.25rem",
  },
  // mt-6 h-10 rounded-full bg-[#E8E044] px-5 text-black hover:bg-[#f1ea55]
  round: {
    marginTop: space.xxl,
    height: "2.5rem",
    borderRadius: "0",
    backgroundColor: {
      default: colors.accent,
      ":hover": colors.accentHover,
    },
    paddingLeft: "1.25rem",
    paddingRight: "1.25rem",
    color: "rgb(0 0 0 / 1)",
  },
});
