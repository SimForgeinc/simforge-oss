import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // font-mono text-[9px] text-amber-100/70
  mono: {
    fontFamily: text.fontMono,
    fontSize: "9px",
    color: "rgb(254 243 199 / 0.7)",
  },
  // flex w-[min(420px,calc(100vw-1rem))] flex-col gap-0 overflow-hidden border-border bg-background p-0 sm:max-w-[420px]
  flexColClip: {
    display: "flex",
    width: "min(420px, calc(100vw - 1rem))",
    flexDirection: "column",
    gap: 0,
    overflow: "hidden",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: 0,
    maxWidth: {
      default: null,
      [layout.bpSm]: "420px",
    },
  },
  // border-b border-border px-5 py-5 pr-12
  ruleB: {
    borderBottomWidth: stroke.hairline,
    borderColor: colors.border,
    paddingLeft: space.s5,
    paddingRight: space.s12,
    paddingTop: space.s5,
    paddingBottom: space.s5,
  },
  // flex min-h-0 flex-1 flex-col
  flexColFill: {
    display: "flex",
    minHeight: "0px",
    flex: "1 1 0%",
    flexDirection: "column",
  },
  // shrink-0 overflow-x-auto border-b border-border px-4 py-3
  tightRuleBScrollX: {
    flexShrink: "0",
    overflowX: "auto",
    borderBottomWidth: stroke.hairline,
    borderColor: colors.border,
    paddingLeft: space.s4,
    paddingRight: space.s4,
    paddingTop: space.s3,
    paddingBottom: space.s3,
  },
  // grid h-auto min-w-[360px] grid-cols-3 rounded-none bg-muted/60 p-1
  gridCols3Pad1: {
    display: "grid",
    height: "auto",
    minWidth: "360px",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    backgroundColor: "hsl(var(--muted) / 0.6)",
    padding: space.s1,
  },
  // gap-1.5 rounded-none px-2 py-2 text-[11px]
  gap15: {
    gap: space.s1_5,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: "11px",
    lineHeight: "inherit",
  },
  // font-mono text-[9px] text-muted-foreground
  monoMuted: {
    fontFamily: text.fontMono,
    fontSize: "9px",
    color: colors.mutedForeground,
  },
  // min-h-0 flex-1 overflow-y-auto p-4
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    padding: space.s4,
  },
  // m-0
  m0: {
    margin: 0,
  },
  // border border-border bg-card/45
  bordered: {
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.45)",
  },
  // flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5
  flexCenterBetween: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderBottomWidth: stroke.hairline,
    borderColor: "hsl(var(--border) / 0.7)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2_5,
    paddingBottom: space.s2_5,
  },
  // text-xs font-semibold text-foreground
  xsInkSemibold: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // size-3.5 text-emerald-400
  size35TextEmerald400: {
    width: "0.875rem",
    height: "0.875rem",
    color: colors.positive,
  },
  // text-[10px] text-muted-foreground
  muted: {
    fontSize: "10px",
    color: colors.mutedForeground,
  },
  // px-3 py-3 text-xs text-muted-foreground
  xsMuted: {
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s3,
    paddingBottom: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // flex items-start gap-2.5 text-left
  flexStartGap25: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2_5,
    textAlign: "left",
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // text-xs font-medium text-foreground
  xsInkMedium: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // mt-1 break-words text-[11px] leading-relaxed text-muted-foreground
  mutedBreakWordsRelaxed: {
    marginTop: space.s1,
    overflowWrap: "break-word",
    fontSize: "11px",
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  // mt-2 border-l-2 border-[#E8E044]/70 pl-2.5
  mt2BorderL2Border70: {
    marginTop: space.s2,
    borderLeftWidth: stroke.thick,
    borderColor: "rgb(232 224 68 / 0.7)",
    paddingLeft: space.s2_5,
  },
  // text-[9px] font-semibold uppercase tracking-[0.16em] text-[#E8E044]
  capsSemibold: {
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.accent,
  },
  // mt-1 break-words text-[11px] leading-relaxed text-foreground/85
  breakWordsRelaxed: {
    marginTop: space.s1,
    overflowWrap: "break-word",
    fontSize: "11px",
    lineHeight: text.lineRelaxed,
    color: "hsl(var(--foreground) / 0.85)",
  },
  // block w-full px-3 py-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset
  blockWide: {
    display: "block",
    width: "100%",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s3,
    paddingBottom: space.s3,
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--muted) / 0.5)",
    },
  },
  // px-3 py-3
  px3Py3: {
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s3,
    paddingBottom: space.s3,
  },
  // h-8 gap-2 rounded-none border bg-card/90 px-3 shadow-sm backdrop-blur border-emerald-400/35 text-emerald-300 hover:bg-emerald-500/10
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: "rgb(52 211 153 / 0.35)",
    backgroundColor: {
      default: "hsl(var(--card) / 0.9)",
      ":hover": "rgb(16 185 129 / 0.1)",
    },
    paddingLeft: space.s3,
    paddingRight: space.s3,
    color: "rgb(110 231 183 / 1)",
    boxShadow: shadows.elevationSm,
    backdropFilter: motion.blurMd,
  },
  // h-8 gap-2 rounded-none border bg-card/90 px-3 shadow-sm backdrop-blur border-amber-400/45 text-amber-200 hover:bg-amber-500/10
  borderedGlassyGap22: {
    height: "2rem",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: "rgb(251 191 36 / 0.45)",
    backgroundColor: {
      default: "hsl(var(--card) / 0.9)",
      ":hover": "rgb(245 158 11 / 0.1)",
    },
    paddingLeft: space.s3,
    paddingRight: space.s3,
    color: "rgb(253 230 138 / 1)",
    boxShadow: shadows.elevationSm,
    backdropFilter: motion.blurMd,
  },
  // mt-0.5 size-3.5 shrink-0 text-destructive
  tightDanger: {
    marginTop: space.s0_5,
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: colors.danger,
  },
  // mt-0.5 size-3.5 shrink-0 text-amber-300
  tight: {
    marginTop: space.s0_5,
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: colors.warning,
  },
  /*
   * `divide-y divide-border/70` was a `> * + *` rule, which StyleX cannot
   * express from the parent, so each row draws the hairline above itself and
   * `:first-child` cancels it — exactly the rows the utility selected.
   */
  rowDivided: {
    borderTopWidth: {
      default: stroke.hairline,
      ":first-child": "0",
    },
    borderTopColor: "hsl(var(--border) / 0.7)",
  },
});
