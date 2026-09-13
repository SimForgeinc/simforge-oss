import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // grid gap-2 rounded-xl border border-[#E8E044]/20 bg-[#E8E044]/[0.04] p-2
  gridBorderedGap2: {
    display: "grid",
    gap: space.md,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(232 224 68 / 0.2)",
    backgroundColor: "rgb(232 224 68 / 0.04)",
    padding: space.md,
  },
  // px-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-[#E8E044]
  capsSemibold: {
    paddingLeft: space.xs,
    paddingRight: space.xs,
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.15em",
    color: colors.accent,
  },
  // grid gap-1 text-[9px] font-semibold uppercase tracking-wider text-white/45
  gridCapsSemibold: {
    display: "grid",
    gap: space.xs,
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "rgb(255 255 255 / 0.45)",
  },
  // min-h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-[10px] font-normal normal-case tracking-normal text-white
  whiteBorderedNormalCase: {
    minHeight: "2rem",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(0 0 0 / 0.4)",
    paddingLeft: space.md,
    paddingRight: space.md,
    fontSize: "10px",
    fontWeight: text.weightNormal,
    textTransform: "none",
    letterSpacing: "0em",
    color: "rgb(255 255 255 / 1)",
  },
  // min-h-8 rounded-lg border border-[#E8E044]/35 bg-[#E8E044]/10 px-2 text-[10px] font-semibold text-[#E8E044] hover:bg-[#E8E044]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  semiboldBordered: {
    minHeight: "2rem",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(232 224 68 / 0.35)",
    backgroundColor: {
      default: "rgb(232 224 68 / 0.1)",
      ":hover": "rgb(232 224 68 / 0.2)",
    },
    paddingLeft: space.md,
    paddingRight: space.md,
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    color: colors.accent,
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 2px rgb(232 224 68 / 1)",
    },
  },
  // text-[9px] leading-4 text-amber-200/80
  textLeading4TextAmber20080: {
    fontSize: "9px",
    lineHeight: "1rem",
    color: "rgb(253 230 138 / 0.8)",
  },
});
