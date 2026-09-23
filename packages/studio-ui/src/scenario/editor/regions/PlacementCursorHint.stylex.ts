import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },

  // pointer-events-none fixed z-[70] flex min-w-[188px] max-w-[320px] items-center gap-2 border px-3 py-2 backdrop-blur-xl
  hint: {
    pointerEvents: "none",
    position: "fixed",
    zIndex: "70",
    display: "flex",
    minWidth: "188px",
    maxWidth: "320px",
    alignItems: "center",
    gap: space.s2,
    borderWidth: stroke.hairline,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    backdropFilter: motion.blurPane,
  },
  // border-amber-300/80 bg-amber-400/25 text-amber-50 shadow-[0_10px_36px_rgba(251,191,36,.22)]
  hintWarning: {
    borderColor: colors.warning,
    backgroundColor: colors.warningWash,
    color: "rgb(255 251 235 / 1)",
    boxShadow: "0 10px 36px rgba(251,191,36,.22)",
  },
  // border-white/10 bg-black/70 text-white shadow-[0_10px_32px_rgba(0,0,0,.22)]
  hintNeutral: {
    borderColor: colors.fillStrong,
    backgroundColor: colors.scrimHeavy,
    color: colors.ink,
    boxShadow: "0 10px 32px rgba(0,0,0,.22)",
  },
  // size-4 shrink-0
  icon: {
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
  },
  // text-amber-300
  iconWarning: {
    color: colors.warning,
  },
  // text-sky-300
  iconReady: {
    color: colors.info,
  },
  // block text-[11px] font-medium leading-tight
  headline: {
    display: "block",
    fontSize: text.sizeMeta,
    fontWeight: text.weightMedium,
    lineHeight: text.lineTight,
  },
  // text-amber-50
  headlineWarning: {
    color: "rgb(255 251 235 / 1)",
  },
  // block max-w-[280px] text-[9px] leading-snug
  detail: {
    display: "block",
    maxWidth: "280px",
    fontSize: text.sizeTag,
    lineHeight: text.lineSnug,
  },
  // text-amber-100/85
  detailWarning: {
    color: colors.warning,
  },
  // text-white/65
  detailNeutral: {
    color: colors.inkSecondary,
  },
});
