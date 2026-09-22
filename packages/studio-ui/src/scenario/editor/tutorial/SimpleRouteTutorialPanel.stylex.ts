import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // fixed inset-0 z-[150] flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm
  fixedFlexCenter: {
    position: "fixed",
    inset: 0,
    zIndex: layers.tutorialTop,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgb(0 0 0 / 0.55)",
    paddingLeft: space.s4,
    paddingRight: space.s4,
    backdropFilter: motion.blurSm,
  },
  // w-full max-w-md border border-white/15 bg-[#111111]/95 p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,0.7)]
  whiteBorderedWide: {
    width: "100%",
    maxWidth: "28rem",
    borderWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(17 17 17 / 0.95)",
    padding: space.s5,
    color: colors.ink,
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.7)",
  },
  // flex items-start gap-3
  flexStartGap3: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
  },
  // flex size-10 shrink-0 items-center justify-center bg-[#E8E044] text-black
  flexCenterMid: {
    display: "flex",
    width: "2.5rem",
    height: "2.5rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    color: "rgb(0 0 0 / 1)",
  },
  // size-5
  size5: {
    width: "1.25rem",
    height: "1.25rem",
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]
  capsMonoBold: {
    fontFamily: text.fontMono,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.accent,
  },
  // mt-1 text-lg font-semibold
  lgSemibold: {
    marginTop: space.s1,
    fontSize: text.sizeLg,
    lineHeight: text.lineLg,
    fontWeight: text.weightSemibold,
  },
  // flex size-8 shrink-0 items-center justify-center text-white/55 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  flexCenterMid2: {
    display: "flex",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    color: {
      default: "rgb(255 255 255 / 0.55)",
      ":hover": colors.ink,
    },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
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
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  /*
   * `space-y-3` was a `> * + *` rule with no StyleX form. Every child is a
   * block-level row with no vertical margin of its own, so a flex column with
   * the same 12px gap places them identically.
   */
  // mt-5
  mt5StackLg: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    marginTop: space.s5,
  },
  // flex gap-3 border-t border-white/10 pt-3
  flexRuleTGap3: {
    display: "flex",
    gap: space.s3,
    borderTopWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.s3,
  },
  // mt-0.5 size-4 shrink-0 text-[#E8E044]
  tight: {
    marginTop: space.s0_5,
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    color: colors.accent,
  },
  // text-sm leading-6 text-white/75
  sm: {
    fontSize: text.sizeSm,
    lineHeight: text.lineBase,
    color: "rgb(255 255 255 / 0.75)",
  },
  // font-semibold text-white
  whiteSemibold: {
    fontWeight: text.weightSemibold,
    color: colors.ink,
  },
  // mt-5 flex items-center justify-between gap-3 border-t border-white/10 pt-4
  flexCenterBetween: {
    marginTop: space.s5,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderTopWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.s4,
  },
  // font-mono text-[9px] uppercase tracking-[0.12em] text-white/40
  capsMono: {
    fontFamily: text.fontMono,
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaTight,
    color: "rgb(255 255 255 / 0.4)",
  },
  // h-10 shrink-0 bg-[#E8E044] px-5 text-xs font-bold uppercase tracking-[0.12em] text-black transition-colors hover:bg-[#f4ed55] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
  tightCapsXs: {
    height: "2.5rem",
    flexShrink: "0",
    backgroundColor: {
      default: colors.accent,
      ":hover": "rgb(244 237 85 / 1)",
    },
    paddingLeft: space.s5,
    paddingRight: space.s5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaTight,
    color: "rgb(0 0 0 / 1)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
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
      ":focus-visible": "0 0 0 2px rgb(255 255 255 / 1)",
    },
  },
});
