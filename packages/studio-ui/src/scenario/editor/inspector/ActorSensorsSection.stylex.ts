import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex items-baseline justify-between gap-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
  },
  // text-[9px] uppercase tracking-[0.12em] text-white/40
  caps: {
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaTight,
    color: "rgb(255 255 255 / 0.4)",
  },
  // font-mono text-[9px] text-white/45
  mono: {
    fontFamily: text.fontMono,
    fontSize: "9px",
    color: "rgb(255 255 255 / 0.45)",
  },
  // text-[9px] leading-3 text-white/35
  textLeading3TextWhite35: {
    fontSize: "9px",
    lineHeight: "0.75rem",
    color: colors.textFaint,
  },
  // text-[9px] leading-3 text-white/45
  textLeading3TextWhite45: {
    fontSize: "9px",
    lineHeight: "0.75rem",
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-0.5 block text-white/30
  block: {
    marginTop: space.xxs,
    display: "block",
    color: "rgb(255 255 255 / 0.3)",
  },
  // flex items-center gap-1.5
  flexCenterGap15: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
  },
  // min-w-0 flex-1 truncate text-[10px] text-white/70
  fillTruncateNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "10px",
    color: "rgb(255 255 255 / 0.7)",
  },
  // ml-1 text-[8px] text-white/30
  ml1TextTextWhite30: {
    marginLeft: space.xs,
    fontSize: "8px",
    color: "rgb(255 255 255 / 0.3)",
  },
  // scale-75
  scale75: {
    transform: "scaleX(0.75) scaleY(0.75)",
  },
  // flex gap-1.5
  flexGap15: {
    display: "flex",
    gap: space.sm,
  },
  // motionStyles.editorMotion + flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/12 bg-white/[0.035] px-2 py-1.5 text-[9px] font-semibold text-white/70 hover:border-[#E8E044]/45 hover:bg-[#E8E044]/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  flexCenterMid: {
    display: "flex",
    flex: "1 1 0%",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    borderRadius: "0",
    borderWidth: "1px",
    backgroundColor: {
      default: "rgb(255 255 255 / 0.035)",
      ":hover": "rgb(232 224 68 / 0.08)",
    },
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    color: {
      default: "rgb(255 255 255 / 0.7)",
      ":hover": "rgb(255 255 255 / 1)",
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
      ":focus-visible": "0 0 0 2px rgb(232 224 68 / 1)",
    },
    borderColor: {
      default: "rgb(255 255 255 / 0.12)",
      ":hover": "rgb(232 224 68 / 0.45)",
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
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(232 224 68 / 0.35)",
    backgroundColor: {
      default: "rgb(232 224 68 / 0.1)",
      ":hover": "rgb(232 224 68 / 0.2)",
    },
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    color: colors.accent,
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
      ":focus-visible": "0 0 0 2px rgb(232 224 68 / 1)",
    },
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
    gap: space.sm,
  },
});
