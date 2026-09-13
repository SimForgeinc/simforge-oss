import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // size-2.5 fill-current
  size25FillCurrent: {
    width: "0.625rem",
    height: "0.625rem",
    fill: "currentColor",
  },
  // size-3 fill-current
  size3FillCurrent: {
    width: "0.75rem",
    height: "0.75rem",
    fill: "currentColor",
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // size-6 rounded-none border-0 bg-transparent p-0 text-white shadow-none hover:bg-transparent enabled:hover:text-[#E8E044] disabled:text-white/25
  whitePad0: {
    width: "1.5rem",
    height: "1.5rem",
    borderRadius: "0",
    borderWidth: "0px",
    backgroundColor: {
      default: "transparent",
      ":hover": "transparent",
    },
    padding: space.none,
    color: {
      default: "rgb(255 255 255 / 1)",
      ":enabled:hover": colors.accent,
      ":disabled": "rgb(255 255 255 / 0.25)",
    },
    boxShadow: "none",
  },
  // flex items-center gap-1 text-white
  flexCenterWhite: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    color: "rgb(255 255 255 / 1)",
  },
});
