import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // mb-3 flex shrink-0 items-start justify-between gap-4
  flexBetweenStart: {
    marginBottom: space.s3,
    display: "flex",
    flexShrink: "0",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.s4,
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // text-sm font-bold tracking-tight text-foreground
  smInkBold: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightBold,
    letterSpacing: "-0.025em",
    color: colors.text,
  },
  // mt-0.5 text-micro text-muted-foreground
  microMuted: {
    marginTop: space.s0_5,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // shrink-0 text-micro uppercase tracking-meta text-muted-foreground
  tightCapsMicro: {
    flexShrink: "0",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // border border-dashed render-hairline px-3 py-2 text-xs text-muted-foreground
  xsMutedBordered: {
    borderWidth: "1px",
    borderStyle: "dashed",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // min-w-0 overflow-x-auto border render-hairline
  borderedNarrowableScrollX: {
    minWidth: "0px",
    overflowX: "auto",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // w-full border-collapse text-left
  wideLeftText: {
    width: "100%",
    borderCollapse: "collapse",
    textAlign: "left",
  },
  // border-b render-hairline
  ruleB: {
    borderBottomWidth: "1px",
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // px-3 py-1.5 text-micro font-bold uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // w-16 px-1 py-1 text-center
  centerText: {
    width: "4rem",
    paddingLeft: space.s1,
    paddingRight: space.s1,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    textAlign: "center",
  },
  // border-b render-hairline last:border-b-0
  ruleB2: {
    borderBottomWidth: {
      default: "1px",
      ":last-child": "0px",
    },
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // px-3 pt-2 text-micro font-bold uppercase tracking-meta text-muted-foreground
  capsMicroMuted2: {
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // min-w-0 px-3 py-1
  narrowable2: {
    minWidth: "0px",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s1,
    paddingBottom: space.s1,
  },
  // motionStyles.editorMotion + flex w-full min-w-0 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  flexCenterWide: {
    display: "flex",
    width: "100%",
    minWidth: "0px",
    alignItems: "center",
    gap: space.s2,
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
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
    },
  },
  // size-3.5 shrink-0 text-muted-foreground
  tightMuted: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: colors.mutedForeground,
  },
  // min-w-0 flex-1 truncate text-xs font-semibold text-foreground
  fillXsInk: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // shrink-0 bg-primary px-1.5 py-0.5 text-micro font-bold uppercase tracking-meta text-primary-foreground
  tightCapsMicro2: {
    flexShrink: "0",
    backgroundColor: colors.primary,
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primaryForeground,
  },
  // px-1 py-1 text-center text-micro text-muted-foreground/40
  microCenterText: {
    paddingLeft: space.s1,
    paddingRight: space.s1,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    textAlign: "center",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: "hsl(var(--muted-foreground) / 0.4)",
  },
  // sr-only
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  // px-1 py-1 text-center
  centerText2: {
    paddingLeft: space.s1,
    paddingRight: space.s1,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    textAlign: "center",
  },
  // size-3 accent-primary
  size3AccentPrimary: {
    width: "0.75rem",
    height: "0.75rem",
    accentColor: colors.primary,
  },
  // mt-1.5 text-micro text-muted-foreground
  microMuted2: {
    marginTop: space.s1_5,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // font-mono
  mono: {
    fontFamily: text.fontMono,
  },
  // motionStyles.editorMotion + w-full px-1 py-0.5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  capsMicroBold: {
    width: "100%",
    paddingLeft: space.s1,
    paddingRight: space.s1,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
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
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
    },
  },
  // border-t render-hairline first:border-t-0
  ruleT: {
    borderTopWidth: {
      default: "1px",
      ":first-child": "0px",
    },
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // size-3.5 shrink-0 text-primary
  tightAccent: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: colors.primary,
  },

  // text-primary
  columnAll: {
    color: colors.primary,
  },
  // text-foreground
  columnSome: {
    color: colors.text,
  },
  // text-muted-foreground hover:text-foreground
  columnNone: {
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
  // bg-primary/10
  povRow: {
    backgroundColor: "hsl(var(--primary) / 0.1)",
  },
});
