import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // grid gap-2 rounded-xl border border-[#E8E044]/20 bg-[#E8E044]/[0.04] p-2
  gridBorderedGap2: {
    display: "grid",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.accentWash,
    padding: space.s2,
  },
  // px-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-[#E8E044]
  capsSemibold: {
    paddingLeft: space.s1,
    paddingRight: space.s1,
    color: colors.accent,
  },
  // grid gap-1 text-[9px] font-semibold uppercase tracking-wider text-white/45
  gridCapsSemibold: {
    display: "grid",
    gap: space.s1,
    color: colors.inkMuted,
  },
  // min-h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-[10px] font-normal normal-case tracking-normal text-white
  whiteBorderedNormalCase: {
    minHeight: "2rem",
    borderWidth: stroke.hairline,
    borderColor: colors.hairlineStrong,
    backgroundColor: colors.scrim,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: text.sizeMicro,
    fontWeight: text.weightNormal,
    textTransform: "none",
    letterSpacing: "0em",
    color: colors.ink,
  },
  // min-h-8 rounded-lg border border-[#E8E044]/35 bg-[#E8E044]/10 px-2 text-[10px] font-semibold text-[#E8E044] hover:bg-[#E8E044]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  semiboldBordered: {
    minHeight: "2rem",
    borderWidth: stroke.hairline,
    borderColor: colors.accentLineSubtle,
    backgroundColor: {
      default: colors.accentWash,
      ":hover": colors.accentWash,
    },
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: text.sizeMicro,
    fontWeight: text.weightSemibold,
    color: colors.accent,
  },
  // text-[9px] leading-4 text-amber-200/80
  textLeading4TextAmber20080: {
    fontSize: text.sizeTag,
    lineHeight: text.lineXs,
    color: colors.warning,
  },
});
