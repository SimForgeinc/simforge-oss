import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // w-editor-rail shrink-0 overflow-y-auto border-r border-white/10 bg-[#0d0d0d] p-3 text-white xl:w-editor-rail-xl
  tightWhiteRuleR: {
    width: {
      default: space.railWidth,
      [layout.bpXl]: space.railWidthXl,
    },
    flexShrink: "0",
    overflowY: "auto",
    borderRightWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: "rgb(13 13 13 / 1)",
    padding: space.s3,
    color: colors.ink,
  },
  // block text-micro font-semibold uppercase tracking-meta-wide text-white/45
  blockCapsMicro: {
    display: "block",
    color: colors.inkMuted,
  },
  // mt-2 flex gap-2
  flexGap2: {
    marginTop: space.s2,
    display: "flex",
    gap: space.s2,
  },
  // h-8 w-20 border-white/15 bg-white/5 text-xs text-white
  xsWhite: {
    width: "5rem",
  },
  // self-center text-xs text-white/45
  xsSelfCenter: {
    alignSelf: "center",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.inkMuted,
  },
  // mt-1 text-micro leading-4 text-white/35
  micro: {
    marginTop: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: text.lineXs,
    color: colors.inkFaint,
  },
  // mt-2 block text-micro font-semibold uppercase tracking-meta-wide text-white/45
  blockCapsMicro2: {
    marginTop: space.s2,
    display: "block",
    color: colors.inkMuted,
  },
  // mt-1 h-8 border-white/15 bg-white/5 text-xs text-white
  xsWhite2: {
    marginTop: space.s1,
  },
  // mt-3
  mt3: {
    marginTop: space.s3,
  },
  // mt-2 text-micro leading-4 text-amber-200
  refusal: {
    marginTop: space.s2,
    fontSize: text.sizeMicro,
    lineHeight: text.lineXs,
    color: colors.warning,
  },
  // mt-2 max-h-36 overflow-y-auto
  scrollY: {
    marginTop: space.s2,
    maxHeight: "9rem",
    overflowY: "auto",
  },
  // text-xs text-white/40
  xs: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.inkMuted,
  },
  // motionStyles.editorMotion + mr-1 mt-1 rounded-sm border border-white/10 bg-white/5 px-2 py-1 text-meta text-white/70 hover:border-[#E8E044]/60 hover:bg-[#E8E044]/10 hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] focus-visible:ring-offset-1 focus-visible:ring-offset-[#0d0d0d]
  metaBordered: {
    marginRight: space.s1,
    marginTop: space.s1,
    borderWidth: stroke.hairline,
    borderColor: {
      default: colors.hairline,
      ":hover": colors.accentLine,
    },
    backgroundColor: {
      default: colors.fillSubtle,
      ":hover": colors.accentWash,
    },
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: {
      default: colors.inkSecondary,
      ":hover": colors.accent,
    },
  },
});
