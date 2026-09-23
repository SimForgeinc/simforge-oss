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
    padding: 0,
  },
  // flex items-center gap-1 text-white
  flexCenterWhite: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    color: colors.ink,
  },
});
