import * as stylex from "@stylexjs/stylex";
import { colors, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // min-w-0 flex-1 overflow-y-auto bg-[#0a0a0a] p-3 text-white
  fillWhiteScrollY: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    backgroundColor: colors.panelSolid,
    padding: space.s3,
    color: colors.ink,
  },
  // mb-2 flex items-center text-micro font-semibold uppercase tracking-meta-wide text-white/45
  flexCenterCaps: {
    marginBottom: space.s2,
    display: "flex",
    alignItems: "center",
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.inkMuted,
  },
  // mr-2 size-3
  mr2Size3: {
    marginRight: space.s2,
    width: "0.75rem",
    height: "0.75rem",
  },
  // ml-auto normal-case tracking-normal
  pushRightNormalCase: {
    marginLeft: "auto",
    textTransform: "none",
    letterSpacing: "0em",
  },
  // motionStyles.editorMotion + flex min-w-0 flex-1 items-center self-stretch px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring
  flexCenterFill: {
    display: "flex",
    minWidth: "0px",
    flex: "1 1 0%",
    alignItems: "center",
    alignSelf: "stretch",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    textAlign: "left",
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
      ":focus-visible": shadows.ringInset,
    },
  },
  // w-24 truncate text-white/40
  truncate: {
    width: "6rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "rgb(255 255 255 / 0.4)",
  },
  // truncate font-medium
  mediumTruncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: text.weightMedium,
  },
  // ml-auto font-mono text-white/45
  monoPushRight: {
    marginLeft: "auto",
    fontFamily: text.fontMono,
    color: colors.inkMuted,
  },
  // motionStyles.editorMotion + mr-2 text-white/30 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  editorMotionMr2TextWhite30: {
    marginRight: space.s2,
    color: {
      default: "rgb(255 255 255 / 0.3)",
      ":hover": "rgb(248 113 113 / 1)",
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
      ":focus-visible": shadows.ringAccent,
    },
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // col-span-2 border-t border-white/10 pt-3
  ruleT: {
    gridColumn: "span 2 / span 2",
    borderTopWidth: stroke.hairline,
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.s3,
  },
  // grid h-16 place-items-center border border-dashed border-white/15 text-xs text-white/35
  gridCenteredXs: {
    display: "grid",
    height: "4rem",
    placeItems: "center",
    borderWidth: stroke.hairline,
    borderStyle: "dashed",
    borderColor: "rgb(255 255 255 / 0.15)",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.inkFaint,
  },
  /*
   * The row list's old `space-y-1`. `space-y` is a `> * + *` rule with no
   * StyleX form; the rows are plain block-level wrappers with no vertical
   * margin, so a flex column with the same 4px gap places them identically.
   */
  stackXs: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },

  // flex h-8 w-full items-center border text-xs
  row: {
    display: "flex",
    height: space.s8,
    width: "100%",
    alignItems: "center",
    borderWidth: stroke.hairline,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // border-[#E8E044]/60 bg-[#E8E044]/10
  rowExpanded: {
    borderColor: colors.accentLine,
    backgroundColor: colors.accentWash,
  },
  // border-white/10 bg-white/[0.035] hover:bg-white/[0.06]
  rowCollapsed: {
    borderColor: colors.fillStrong,
    backgroundColor: {
      default: "rgb(255 255 255 / 0.035)",
      ":hover": colors.fill,
    },
  },
  // grid grid-cols-2 gap-3 border-x border-b border-white/10 bg-[#111111] p-3
  inspector: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s3,
    borderLeftWidth: stroke.hairline,
    borderRightWidth: stroke.hairline,
    borderBottomWidth: stroke.hairline,
    borderColor: colors.fillStrong,
    backgroundColor: "rgb(17 17 17 / 1)",
    padding: space.s3,
  },
  // hidden
  inspectorCollapsed: {
    display: "none",
  },
});
