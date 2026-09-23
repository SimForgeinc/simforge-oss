import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, motion, shadows, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-auto absolute inset-0 z-[80] grid place-items-center bg-black/65 p-6 backdrop-blur-sm
  absGridCentered: {
    pointerEvents: "auto",
    position: "absolute",
    inset: 0,
    zIndex: layers.editorOverlay,
    display: "grid",
    placeItems: "center",
    backgroundColor: colors.scrimHeavy,
    padding: space.s6,
    backdropFilter: motion.blurSm,
  },
  // w-full max-w-xl rounded-2xl border border-white/15 bg-[#111317] p-6 shadow-2xl
  borderedWidePad6: {
    width: "100%",
    maxWidth: "36rem",
    borderWidth: stroke.hairline,
    borderColor: colors.hairlineStrong,
    backgroundColor: "rgb(17 19 23 / 1)",
    padding: space.s6,
    boxShadow: shadows.elevation2xl,
  },
  // text-xl font-semibold text-white
  xlWhiteSemibold: {
    fontSize: text.sizeXl,
    lineHeight: text.lineLg,
    fontWeight: text.weightSemibold,
    color: colors.ink,
  },
  // mt-2 text-sm text-white/55
  sm: {
    marginTop: space.s2,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.inkMuted,
  },
  // mt-5 grid gap-3 sm:grid-cols-2
  gridGap3: {
    marginTop: space.s5,
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: {
      default: null,
      [layout.bpSm]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // rounded-xl border border-[#E8E044]/50 bg-[#E8E044]/8 p-4 text-left hover:bg-[#E8E044]/12
  borderedPad4LeftText: {
    borderWidth: stroke.hairline,
    borderColor: colors.accentLine,
    backgroundColor: {
      default: colors.accentWash,
      ":hover": colors.accentWash,
    },
    padding: space.s4,
    textAlign: "left",
  },
  // size-6 text-[#E8E044]
  size6Text: {
    width: "1.5rem",
    height: "1.5rem",
    color: colors.accent,
  },
  // mt-3 block text-sm text-white
  blockSmWhite: {
    marginTop: space.s3,
    display: "block",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.ink,
  },
  // mt-1 block text-xs leading-5 text-white/55
  blockXs: {
    marginTop: space.s1,
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.inkMuted,
  },
  // rounded-xl border border-white/15 bg-white/[0.03] p-4 text-left hover:bg-white/[0.06]
  borderedPad4LeftText2: {
    borderWidth: stroke.hairline,
    borderColor: colors.hairlineStrong,
    backgroundColor: {
      default: colors.fillFaint,
      ":hover": colors.fill,
    },
    padding: space.s4,
    textAlign: "left",
  },
  // size-6 text-white/70
  size6TextWhite70: {
    width: "1.5rem",
    height: "1.5rem",
    color: colors.inkSecondary,
  },
});
