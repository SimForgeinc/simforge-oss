import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

/** `animate-pulse`. */
const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

export const styles = stylex.create({
  // text-[9px] leading-relaxed text-white/45
  relaxed: {
    fontSize: "9px",
    lineHeight: "1.625",
    color: "rgb(255 255 255 / 0.45)",
  },
  // h-8 w-full rounded-md border border-white/15 bg-black/25 px-2.5 text-[11px] text-white outline-none placeholder:text-white/35 focus:border-white/30
  whiteBorderedWide: {
    height: "2rem",
    width: "100%",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: {
      default: "rgb(255 255 255 / 0.15)",
      ":focus": "rgb(255 255 255 / 0.3)",
    },
    backgroundColor: colors.overlayMat,
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    fontSize: "11px",
    color: "rgb(255 255 255 / 1)",
    outline: "2px solid transparent",
    outlineOffset: "2px",
    "::-moz-placeholder": {
      color: colors.textFaint,
    },
    "::placeholder": {
      color: colors.textFaint,
    },
  },
  // flex gap-1
  flexGap1: {
    display: "flex",
    gap: space.xs,
  },
  // grid grid-cols-2 gap-2
  gridCols2Gap2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
  },
  // aspect-square w-full bg-black/20 object-contain
  wideSquareContain: {
    aspectRatio: "1 / 1",
    width: "100%",
    backgroundColor: "rgb(0 0 0 / 0.2)",
    objectFit: "contain",
  },
  // min-w-0 px-2 py-1.5
  narrowable: {
    minWidth: "0px",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  // block truncate text-[10px] font-semibold text-white/85
  blockSemiboldTruncate: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    color: "rgb(255 255 255 / 0.85)",
  },
  // block truncate text-[8px] text-white/40
  blockTruncate: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "8px",
    color: "rgb(255 255 255 / 0.4)",
  },
  // mt-1.5
  mt15: {
    marginTop: space.sm,
  },
  // absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-[#f08a43]
  absPulsing: {
    position: "absolute",
    left: space.none,
    right: space.none,
    bottom: space.none,
    height: "0.125rem",
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
    backgroundColor: "rgb(240 138 67 / 1)",
  },
  // py-16 text-center text-[10px] text-white/45
  centerText: {
    paddingTop: "4rem",
    paddingBottom: "4rem",
    textAlign: "center",
    fontSize: "10px",
    color: "rgb(255 255 255 / 0.45)",
  },
  // text-[9px] leading-relaxed text-red-300
  relaxed2: {
    fontSize: "9px",
    lineHeight: "1.625",
    color: "rgb(252 165 165 / 1)",
  },
  // w-full rounded-md border border-white/10 bg-white/[0.05] py-2 text-[10px] text-white/65 disabled:opacity-50
  borderedWide: {
    width: "100%",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(255 255 255 / 0.05)",
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: "10px",
    color: "rgb(255 255 255 / 0.65)",
    opacity: {
      default: null,
      ":disabled": "0.5",
    },
  },
  // py-2 text-center text-[9px] text-white/40
  centerText2: {
    paddingTop: space.md,
    paddingBottom: space.md,
    textAlign: "center",
    fontSize: "9px",
    color: "rgb(255 255 255 / 0.4)",
  },
  /*
   * The panel's old `space-y-3`. `space-y` is a `> * + *` rule with no StyleX
   * form, and a flex column is not a substitute here: the search field is an
   * inline-level control, and blockifying it would drop the line box it sits
   * in. The 12px margin therefore travels on the children, with
   * `:first-child` cancelling it exactly as `> :not([hidden]) ~
   * :not([hidden])` did.
   */
  stackedLg: {
    marginTop: {
      default: space.lg,
      ":first-child": space.none,
    },
  },

  // rounded-full border px-2.5 py-1 text-[9px]
  ownershipChip: {
    borderRadius: "0",
    borderWidth: "1px",
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: "9px",
  },
  // border-[#d56d27] bg-[#5a3521] text-[#ffd2b2]
  ownershipChipActive: {
    borderColor: "rgb(213 109 39 / 1)",
    backgroundColor: "rgb(90 53 33 / 1)",
    color: "rgb(255 210 178 / 1)",
  },
  // border-white/10 bg-white/[0.04] text-white/55
  ownershipChipIdle: {
    borderColor: colors.chip,
    backgroundColor: colors.glass,
    color: "rgb(255 255 255 / 0.55)",
  },
  // relative overflow-hidden rounded-md border bg-white/[0.04]
  // (the `group` marker went with the migration: nothing in this panel reads an
  // ancestor hover, so it was an inert class.)
  tile: {
    position: "relative",
    overflow: "hidden",
    borderRadius: "0",
    borderWidth: "1px",
    backgroundColor: colors.glass,
  },
  // border-[#f08a43] bg-[#4a3020]
  tileActive: {
    borderColor: "rgb(240 138 67 / 1)",
    backgroundColor: "rgb(74 48 32 / 1)",
  },
  // border-white/10
  tileIdle: {
    borderColor: colors.chip,
  },
  // cursor-grab outline-none
  tileGrip: {
    cursor: "grab",
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // cursor-wait opacity-60
  tileGripWaiting: {
    cursor: "wait",
    opacity: 0.6,
  },
  // absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/55 text-sm
  favoriteToggle: {
    position: "absolute",
    right: space.xs,
    top: space.xs,
    display: "grid",
    width: "1.5rem",
    height: "1.5rem",
    placeItems: "center",
    borderRadius: "0",
    backgroundColor: "rgb(0 0 0 / 0.55)",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // text-amber-300
  favoriteToggleOn: {
    color: "rgb(252 211 77 / 1)",
  },
  // text-white/55
  favoriteToggleOff: {
    color: "rgb(255 255 255 / 0.55)",
  },
});
