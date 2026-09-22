import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex items-baseline justify-between gap-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
  },
  // text-[9px] uppercase tracking-[0.12em] text-white/40
  caps: {
    color: colors.inkMuted,
  },
  // font-mono text-[9px] text-white/45
  mono: {
    fontFamily: text.fontMono,
    fontSize: text.sizeTag,
    color: colors.inkMuted,
  },
  // text-[9px] leading-3 text-white/35
  textLeading3TextWhite35: {
    fontSize: text.sizeTag,
    lineHeight: "0.75rem",
    color: colors.inkFaint,
  },
  // text-[9px] leading-3 text-white/45
  textLeading3TextWhite45: {
    fontSize: text.sizeTag,
    lineHeight: "0.75rem",
    color: colors.inkMuted,
  },
  // mt-0.5 block text-white/30
  block: {
    marginTop: space.s0_5,
    display: "block",
    color: colors.inkFaint,
  },
  // flex items-center gap-1.5
  flexCenterGap15: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
  },
  // min-w-0 flex-1 truncate text-[10px] text-white/70
  fillTruncateNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
    fontSize: text.sizeMicro,
    color: colors.inkSecondary,
  },
  // ml-1 text-[8px] text-white/30
  ml1TextTextWhite30: {
    marginLeft: space.s1,
    fontSize: text.sizeNano,
    color: colors.inkFaint,
  },
  // scale-75
  scale75: {
    transform: "scaleX(0.75) scaleY(0.75)",
  },
  // flex gap-1.5
  flexGap15: {
    display: "flex",
    flexWrap: "wrap",
    minWidth: 0,
    gap: space.s1_5,
  },
  // motionStyles.editorMotion + flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/12 bg-white/[0.035] px-2 py-1.5 text-[9px] font-semibold text-white/70 hover:border-[#E8E044]/45 hover:bg-[#E8E044]/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  flexCenterMid: {
    display: "flex",
    flex: "1 1 auto",
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1,
    borderWidth: stroke.hairline,
    backgroundColor: {
      default: colors.fillSubtle,
      ":hover": colors.accentWash,
    },
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    fontSize: text.sizeTag,
    fontWeight: text.weightSemibold,
    color: {
      default: colors.inkSecondary,
      ":hover": colors.ink,
    },
    borderColor: {
      default: colors.hairlineStrong,
      ":hover": colors.accentLineSubtle,
    },
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // motionStyles.editorMotion + flex items-center justify-center gap-1 rounded-lg border border-[#E8E044]/35 bg-[#E8E044]/10 px-2 py-1.5 text-[9px] font-semibold text-[#E8E044] hover:bg-[#E8E044]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  flexCenterMid2: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1,
    borderWidth: stroke.hairline,
    borderColor: colors.accentLineSubtle,
    backgroundColor: {
      default: colors.accentWash,
      ":hover": colors.accentWash,
    },
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    fontSize: text.sizeTag,
    fontWeight: text.weightSemibold,
    color: colors.accent,
  },
  /*
   * The section's old `space-y-1.5`. `space-y` is a `> * + *` sibling rule,
   * which StyleX cannot express — a style reaches only the element it is set
   * on. Every child here is already a block-level box carrying no vertical
   * margin, so a flex column with the same gap places them identically.
   */
  stackSm: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
  },
});
