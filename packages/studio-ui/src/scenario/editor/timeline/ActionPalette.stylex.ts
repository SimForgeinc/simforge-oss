import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // w-editor-rail shrink-0 overflow-y-auto border-r border-white/10 bg-[#0d0d0d] p-3 text-white xl:w-editor-rail-xl
  tightWhiteRuleR: {
    width: {
      default: space.railWidth,
      "@media (min-width: 1280px)": space.railWidthXl,
    },
    flexShrink: "0",
    overflowY: "auto",
    borderRightWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(13 13 13 / 1)",
    padding: space.lg,
    color: "rgb(255 255 255 / 1)",
  },
  // block text-micro font-semibold uppercase tracking-meta-wide text-white/45
  blockCapsMicro: {
    display: "block",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-2 flex gap-2
  flexGap2: {
    marginTop: space.md,
    display: "flex",
    gap: space.md,
  },
  // h-8 w-20 border-white/15 bg-white/5 text-xs text-white
  xsWhite: {
    height: "2rem",
    width: "5rem",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(255 255 255 / 0.05)",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 1)",
  },
  // self-center text-xs text-white/45
  xsSelfCenter: {
    alignSelf: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-1 text-micro leading-4 text-white/35
  micro: {
    marginTop: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "1rem",
    color: colors.textFaint,
  },
  // mt-2 block text-micro font-semibold uppercase tracking-meta-wide text-white/45
  blockCapsMicro2: {
    marginTop: space.md,
    display: "block",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-1 h-8 border-white/15 bg-white/5 text-xs text-white
  xsWhite2: {
    marginTop: space.xs,
    height: "2rem",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(255 255 255 / 0.05)",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 1)",
  },
  // mt-3
  mt3: {
    marginTop: space.lg,
  },
  // mt-2 max-h-36 overflow-y-auto
  scrollY: {
    marginTop: space.md,
    maxHeight: "9rem",
    overflowY: "auto",
  },
  // text-xs text-white/40
  xs: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.4)",
  },
  // motionStyles.editorMotion + mr-1 mt-1 rounded-sm border border-white/10 bg-white/5 px-2 py-1 text-meta text-white/70 hover:border-[#E8E044]/60 hover:bg-[#E8E044]/10 hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] focus-visible:ring-offset-1 focus-visible:ring-offset-[#0d0d0d]
  metaBordered: {
    marginRight: space.xs,
    marginTop: space.xs,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: {
      default: "rgb(255 255 255 / 0.1)",
      ":hover": "rgb(232 224 68 / 0.6)",
    },
    backgroundColor: {
      default: "rgb(255 255 255 / 0.05)",
      ":hover": "rgb(232 224 68 / 0.1)",
    },
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
    color: {
      default: "rgb(255 255 255 / 0.7)",
      ":hover": colors.accent,
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
      ":focus-visible": "0 0 0 1px #0d0d0d, 0 0 0 3px rgb(232 224 68 / 1)",
    },
  },
});
