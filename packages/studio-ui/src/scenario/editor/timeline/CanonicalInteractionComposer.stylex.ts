import * as stylex from "@stylexjs/stylex";
import { colors, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // grid gap-2 rounded-xl border border-[#E8E044]/20 bg-[#E8E044]/[0.04] p-2
  gridBorderedGap2: {
    display: "grid",
    gap: space.s2,
    borderRadius: "0",
    borderWidth: stroke.hairline,
    borderColor: "rgb(232 224 68 / 0.2)",
    backgroundColor: "rgb(232 224 68 / 0.04)",
    padding: space.s2,
  },
  // px-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-[#E8E044]
  capsSemibold: {
    paddingLeft: space.s1,
    paddingRight: space.s1,
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.15em",
    color: colors.accent,
  },
  // grid gap-1 text-[9px] font-semibold uppercase tracking-wider text-white/45
  gridCapsSemibold: {
    display: "grid",
    gap: space.s1,
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingWider,
    color: colors.inkMuted,
  },
  // min-h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-[10px] font-normal normal-case tracking-normal text-white
  whiteBorderedNormalCase: {
    minHeight: "2rem",
    borderRadius: "0",
    borderWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(0 0 0 / 0.4)",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: "10px",
    fontWeight: text.weightNormal,
    textTransform: "none",
    letterSpacing: "0em",
    color: colors.ink,
  },
  // min-h-8 rounded-lg border border-[#E8E044]/35 bg-[#E8E044]/10 px-2 text-[10px] font-semibold text-[#E8E044] hover:bg-[#E8E044]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  semiboldBordered: {
    minHeight: "2rem",
    borderRadius: "0",
    borderWidth: stroke.hairline,
    borderColor: "rgb(232 224 68 / 0.35)",
    backgroundColor: {
      default: colors.accentWash,
      ":hover": "rgb(232 224 68 / 0.2)",
    },
    paddingLeft: space.s2,
    paddingRight: space.s2,
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
      ":focus-visible": shadows.ringAccent,
    },
  },
  // text-[9px] leading-4 text-amber-200/80
  textLeading4TextAmber20080: {
    fontSize: "9px",
    lineHeight: text.lineXs,
    color: "rgb(253 230 138 / 0.8)",
  },
});
