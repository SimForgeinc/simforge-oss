import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

/** `animate-pulse`. */
const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

export const styles = stylex.create({
  // pointer-events-none fixed inset-0 z-[130]
  fixedInertInset0: {
    pointerEvents: "none",
    position: "fixed",
    inset: 0,
    zIndex: "130",
  },
  // absolute inset-0 bg-black/20
  absInset0: {
    position: "absolute",
    inset: 0,
    backgroundColor: "rgb(0 0 0 / 0.2)",
  },
  // absolute border-2 border-[#E8E044] shadow-[0_0_0_4px_rgba(232,224,68,0.16),0_0_24px_rgba(232,224,68,0.3)]
  abs: {
    position: "absolute",
    borderWidth: stroke.thick,
    borderColor: colors.accent,
    boxShadow: "0 0 0 4px rgba(232, 224, 68, 0.16), 0 0 24px rgba(232, 224, 68, 0.3)",
  },
  // pointer-events-auto absolute w-[min(360px,calc(100vw-24px))] border border-[#E8E044]/55 bg-[#11120f]/95 p-4 text-white shadow-2xl backdrop-blur-xl focus:outline-none
  absWhiteBordered: {
    pointerEvents: "auto",
    position: "absolute",
    width: "min(360px, calc(100vw - 24px))",
    borderWidth: stroke.hairline,
    borderColor: "rgb(232 224 68 / 0.55)",
    backgroundColor: "rgb(17 18 15 / 0.95)",
    padding: space.s4,
    color: colors.ink,
    boxShadow: shadows.elevation2xl,
    backdropFilter: motion.blurPane,
    outline: {
      default: null,
      ":focus": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus": "2px",
    },
  },
  // flex items-start gap-3
  flexStartGap3: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#E8E044]
  capsMonoBold: {
    fontFamily: text.fontMono,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.accent,
  },
  // mt-1.5 text-base font-semibold
  semiboldBase: {
    marginTop: space.s1_5,
    fontSize: text.sizeBase,
    lineHeight: text.lineBase,
    fontWeight: text.weightSemibold,
  },
  // grid size-7 shrink-0 place-items-center text-white/55 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  gridCenteredTight: {
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: "0",
    placeItems: "center",
    color: {
      default: "rgb(255 255 255 / 0.55)",
      ":hover": colors.ink,
    },
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
    backgroundColor: {
      default: null,
      ":hover": colors.fillStrong,
    },
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // mt-2 text-xs leading-5 text-white/60
  xs: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: "rgb(255 255 255 / 0.6)",
  },
  // mt-4 flex items-center gap-2 border border-[#E8E044]/30 bg-[#E8E044]/[0.08] px-3 py-2.5
  flexCenterBordered: {
    marginTop: space.s4,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.accentLineSubtle,
    backgroundColor: "rgb(232 224 68 / 0.08)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2_5,
    paddingBottom: space.s2_5,
  },
  // size-4 shrink-0 text-[#E8E044]
  tight: {
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    color: colors.accent,
  },
  // size-2 shrink-0 animate-pulse rounded-full bg-[#E8E044] motion-reduce:animate-none
  tightRoundPulsing: {
    width: "0.5rem",
    height: "0.5rem",
    flexShrink: "0",
    animationName: {
      default: pulse,
      [layout.reducedMotion]: "none",
    },
    animationDuration: motion.durPulse,
    animationTimingFunction: motion.easePulse,
    animationIterationCount: "infinite",
    borderRadius: "0",
    backgroundColor: colors.accent,
  },
  // text-xs font-medium text-[#E8E044]
  xsMedium: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.accent,
  },
  // mt-4 h-8 w-full
  wide: {
    marginTop: space.s4,
    height: "2rem",
    width: "100%",
  },
  // mt-3 text-[10px] leading-4 text-white/40
  mt3TextLeading4: {
    marginTop: space.s3,
    fontSize: "10px",
    lineHeight: text.lineXs,
    color: "rgb(255 255 255 / 0.4)",
  },
});
