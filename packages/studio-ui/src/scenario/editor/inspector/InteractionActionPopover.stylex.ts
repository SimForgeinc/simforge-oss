import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex flex-col items-center gap-1 text-center
  flexColCenter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.xs,
    textAlign: "center",
  },
  // size-9 text-[#E8E044]
  size9Text: {
    width: "2.25rem",
    height: "2.25rem",
    color: colors.accent,
  },
  // text-xs font-medium text-white
  xsWhiteMedium: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: "rgb(255 255 255 / 1)",
  },
  // motionStyles.editorMotion + flex h-10 w-full items-center justify-center rounded-lg border border-[#E8E044] bg-[#E8E044] px-3 text-xs font-semibold text-black hover:bg-[#f4ed5d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
  flexCenterMid: {
    display: "flex",
    height: "2.5rem",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: colors.accent,
    backgroundColor: {
      default: colors.accent,
      ":hover": "rgb(244 237 93 / 1)",
    },
    paddingLeft: space.lg,
    paddingRight: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: "rgb(0 0 0 / 1)",
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
  // text-[9px] uppercase tracking-[0.16em] text-white/40
  caps: {
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgb(255 255 255 / 0.4)",
  },
  // max-w-full truncate text-xs font-medium text-white
  xsWhiteMedium2: {
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: "rgb(255 255 255 / 1)",
  },
  // break-all text-[10px] uppercase tracking-[0.14em] text-white/40
  capsBreakAll: {
    wordBreak: "break-all",
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "rgb(255 255 255 / 0.4)",
  },
  // grid grid-cols-1 gap-3
  gridCols1Gap3: {
    display: "grid",
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    gap: space.lg,
  },
  // border-t border-white/10 pt-3
  ruleT: {
    borderTopWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.lg,
  },
  // motionStyles.editorMotion + flex w-full items-center justify-center gap-2 border border-red-400/30 px-3 py-2 text-xs text-red-300 hover:bg-red-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300
  flexCenterMid2: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    borderWidth: "1px",
    borderColor: "rgb(248 113 113 / 0.3)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(252 165 165 / 1)",
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
      ":focus-visible": "0 0 0 2px rgb(252 165 165 / 1)",
    },
    backgroundColor: {
      default: null,
      ":hover": "rgb(248 113 113 / 0.1)",
    },
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  /*
   * The editor body's old `space-y-4`. `space-y` is a `> * + *` rule with no
   * StyleX form; every child here is already a block-level box with no
   * vertical margin, so a flex column with a 16px gap places them identically.
   */
  stackXl: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
});
