import * as stylex from "@stylexjs/stylex";
import { colors, motion, shadows, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-none fixed z-[85] -translate-x-1/2 -translate-y-full
  fixedInert: {
    pointerEvents: "none",
    position: "fixed",
    zIndex: "85",
    transform: "translate(-50%, -100%)",
  },
  // pointer-events-auto flex items-center gap-2 rounded-md border border-amber-300/80 bg-black/90 px-2 py-1 text-[11px] font-medium leading-snug text-amber-100 shadow-lg backdrop-blur-md
  flexCenterMedium: {
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.warning,
    backgroundColor: colors.scrimHeavy,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontSize: text.sizeMeta,
    fontWeight: text.weightMedium,
    lineHeight: text.lineSnug,
    color: colors.warning,
    boxShadow: shadows.elevationLg,
    backdropFilter: motion.blurGlass,
  },
  // rounded-sm border border-amber-300/60 px-1.5 py-0.5 text-amber-50 transition-colors hover:bg-amber-300/20
  bordered: {
    borderWidth: stroke.hairline,
    borderColor: colors.warning,
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    color: "rgb(255 251 235 / 1)",
    backgroundColor: {
      default: null,
      ":hover": colors.warningWash,
    },
  },
});
