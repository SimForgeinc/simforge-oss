import * as stylex from "@stylexjs/stylex";
import { colors, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // grid min-w-0 grid-cols-1 gap-3 border-t border-white/10 pt-3
  gridRuleTNarrowable: {
    display: "grid",
    minWidth: "0px",
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    gap: space.s3,
    borderTopWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.s3,
  },
  // text-meta font-semibold uppercase tracking-wider text-muted-foreground
  capsMetaMuted: {
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingWider,
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  muted: {
    color: colors.mutedForeground,
  },
  // mt-0.5 text-meta leading-4 text-white/35
  meta: {
    marginTop: space.s0_5,
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: colors.inkFaint,
  },
  // mt-2 grid grid-cols-1 gap-1.5
  gridCols1Gap15: {
    marginTop: space.s2,
    display: "grid",
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    gap: space.s1_5,
  },
  // block text-[10px] font-medium
  blockMedium: {
    display: "block",
    fontSize: "10px",
    fontWeight: text.weightMedium,
  },
  // mt-0.5 block text-[9px] leading-3.5 opacity-70
  block: {
    marginTop: space.s0_5,
    display: "block",
    fontSize: "9px",
    lineHeight: text.lineMicro,
    opacity: "0.7",
  },
  // mt-1.5 text-meta leading-4 text-white/35
  meta2: {
    marginTop: space.s1_5,
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: colors.inkFaint,
  },
  // text-meta text-red-300
  meta3: {
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: colors.critical,
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // block text-muted-foreground
  blockMuted: {
    display: "block",
    color: colors.mutedForeground,
  },
  // mt-1 h-8
  mt1H8: {
    marginTop: space.s1,
    height: "2rem",
  },

  // rounded-lg border px-2 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  styleOption: {
    borderRadius: "0",
    borderWidth: stroke.hairline,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter",
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
  // border-[#E8E044]/70 bg-[#E8E044]/10 text-[#E8E044]
  styleOptionActive: {
    borderColor: "rgb(232 224 68 / 0.7)",
    backgroundColor: colors.accentWash,
    color: colors.accent,
  },
  // border-white/10 bg-white/[0.025] text-white/60 hover:border-white/25 hover:bg-white/[0.06] hover:text-white/90
  styleOptionIdle: {
    borderColor: {
      default: colors.fillStrong,
      ":hover": "rgb(255 255 255 / 0.25)",
    },
    backgroundColor: {
      default: "rgb(255 255 255 / 0.025)",
      ":hover": colors.fill,
    },
    color: {
      default: "rgb(255 255 255 / 0.6)",
      ":hover": "rgb(255 255 255 / 0.9)",
    },
  },
});
