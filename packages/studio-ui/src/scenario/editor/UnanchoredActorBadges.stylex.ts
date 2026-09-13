import * as stylex from "@stylexjs/stylex";
import { text, space, motion } from "../../stylex/tokens.stylex";

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
    gap: space.md,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(252 211 77 / 0.8)",
    backgroundColor: "rgb(0 0 0 / 0.9)",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: "11px",
    fontWeight: text.weightMedium,
    lineHeight: "1.375",
    color: "rgb(254 243 199 / 1)",
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(12px)",
  },
  // rounded-sm border border-amber-300/60 px-1.5 py-0.5 text-amber-50 transition-colors hover:bg-amber-300/20
  bordered: {
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(252 211 77 / 0.6)",
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    color: "rgb(255 251 235 / 1)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
    backgroundColor: {
      default: null,
      ":hover": "rgb(252 211 77 / 0.2)",
    },
  },
});
