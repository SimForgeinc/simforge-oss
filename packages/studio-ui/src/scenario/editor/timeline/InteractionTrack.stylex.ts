import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // relative h-2.5 overflow-hidden bg-black/30
  relClip: {
    position: "relative",
    height: "0.625rem",
    overflow: "hidden",
    backgroundColor: "rgb(0 0 0 / 0.3)",
  },
  // absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10
  abs: {
    position: "absolute",
    left: space.none,
    right: space.none,
    top: "50%",
    height: "1px",
    transform: "translate(0, -50%)",
    backgroundColor: colors.chip,
  },

  // absolute inset-y-0.5 min-w-px rounded-[2px] shadow-[0_0_12px_rgba(232,224,68,0.14)]
  bar: {
    position: "absolute",
    top: "0.125rem",
    bottom: "0.125rem",
    minWidth: "1px",
    borderRadius: "2px",
    boxShadow: "0 0 12px rgba(232,224,68,0.14)",
  },
  // border-y border-l border-dashed border-[#E8E044] bg-[#E8E044]/20
  barArmed: {
    borderTopWidth: "1px",
    borderBottomWidth: "1px",
    borderLeftWidth: "1px",
    borderStyle: "dashed",
    borderColor: colors.accent,
    backgroundColor: "rgb(232 224 68 / 0.2)",
  },
  // bg-[#E8E044]/75
  barExact: {
    backgroundColor: "rgb(232 224 68 / 0.75)",
  },
  // opacity-70
  barOpenEnded: {
    opacity: 0.7,
  },
});
