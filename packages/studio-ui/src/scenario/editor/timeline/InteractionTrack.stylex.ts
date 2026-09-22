import * as stylex from "@stylexjs/stylex";
import { colors, stroke } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // relative h-2.5 overflow-hidden bg-black/30
  relClip: {
    position: "relative",
    height: "0.625rem",
    overflow: "hidden",
    backgroundColor: colors.scrimLight,
  },
  // absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10
  abs: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    height: "1px",
    transform: "translate(0, -50%)",
    backgroundColor: colors.fillStrong,
  },

  // absolute inset-y-0.5 min-w-px rounded-[2px] shadow-[0_0_12px_rgba(232,224,68,0.14)]
  bar: {
    position: "absolute",
    top: "0.125rem",
    bottom: "0.125rem",
    minWidth: "1px",
    boxShadow: "0 0 12px rgba(232,224,68,0.14)",
  },
  // border-y border-l border-dashed border-[#E8E044] bg-[#E8E044]/20
  barArmed: {
    borderTopWidth: stroke.hairline,
    borderBottomWidth: stroke.hairline,
    borderLeftWidth: stroke.hairline,
    borderStyle: "dashed",
    borderColor: colors.accent,
    backgroundColor: colors.accentWash,
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
