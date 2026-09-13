import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../../stylex/tokens.stylex";

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
    gap: space.md,
    borderWidth: "1px",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    backdropFilter: "blur(24px)",
  },
  // border-amber-300/80 bg-amber-400/25 text-amber-50 shadow-[0_10px_36px_rgba(251,191,36,.22)]
  hintWarning: {
    borderColor: "rgb(252 211 77 / 0.8)",
    backgroundColor: "rgb(251 191 36 / 0.25)",
    color: "rgb(255 251 235 / 1)",
    boxShadow: "0 10px 36px rgba(251,191,36,.22)",
  },
  // border-white/10 bg-black/70 text-white shadow-[0_10px_32px_rgba(0,0,0,.22)]
  hintNeutral: {
    borderColor: colors.chip,
    backgroundColor: "rgb(0 0 0 / 0.7)",
    color: "rgb(255 255 255 / 1)",
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
    color: "rgb(252 211 77 / 1)",
  },
  // text-sky-300
  iconReady: {
    color: "rgb(125 211 252 / 1)",
  },
  // block text-[11px] font-medium leading-tight
  headline: {
    display: "block",
    fontSize: "11px",
    fontWeight: text.weightMedium,
    lineHeight: "1.25",
  },
  // text-amber-50
  headlineWarning: {
    color: "rgb(255 251 235 / 1)",
  },
  // block max-w-[280px] text-[9px] leading-snug
  detail: {
    display: "block",
    maxWidth: "280px",
    fontSize: "9px",
    lineHeight: "1.375",
  },
  // text-amber-100/85
  detailWarning: {
    color: "rgb(254 243 199 / 0.85)",
  },
  // text-white/65
  detailNeutral: {
    color: "rgb(255 255 255 / 0.65)",
  },
});
