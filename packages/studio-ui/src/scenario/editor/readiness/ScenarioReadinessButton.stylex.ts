import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

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
    gap: space.none,
    overflow: "hidden",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: space.none,
    maxWidth: {
      default: null,
      "@media (min-width: 640px)": "420px",
    },
  },
  // border-b border-border px-5 py-5 pr-12
  ruleB: {
    borderBottomWidth: "1px",
    borderColor: colors.border,
    paddingLeft: "1.25rem",
    paddingRight: "3rem",
    paddingTop: "1.25rem",
    paddingBottom: "1.25rem",
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
    borderBottomWidth: "1px",
    borderColor: colors.border,
    paddingLeft: space.xl,
    paddingRight: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.lg,
  },
  // grid h-auto min-w-[360px] grid-cols-3 rounded-none bg-muted/60 p-1
  gridCols3Pad1: {
    display: "grid",
    height: "auto",
    minWidth: "360px",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    borderRadius: "0",
    backgroundColor: "hsl(var(--muted) / 0.6)",
    padding: space.xs,
  },
  // gap-1.5 rounded-none px-2 py-2 text-[11px]
  gap15: {
    gap: space.sm,
    borderRadius: "0",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: "11px",
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
    padding: space.xl,
  },
  // m-0
  m0: {
    margin: space.none,
  },
  // border border-border bg-card/45
  bordered: {
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.45)",
  },
  // flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5
  flexCenterBetween: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
    borderBottomWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: "0.625rem",
    paddingBottom: "0.625rem",
  },
  // text-xs font-semibold text-foreground
  xsInkSemibold: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // size-3.5 text-emerald-400
  size35TextEmerald400: {
    width: "0.875rem",
    height: "0.875rem",
    color: "rgb(52 211 153 / 1)",
  },
  // text-[10px] text-muted-foreground
  muted: {
    fontSize: "10px",
    color: colors.mutedForeground,
  },
  // px-3 py-3 text-xs text-muted-foreground
  xsMuted: {
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // flex items-start gap-2.5 text-left
  flexStartGap25: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.625rem",
    textAlign: "left",
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // text-xs font-medium text-foreground
  xsInkMedium: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // mt-1 break-words text-[11px] leading-relaxed text-muted-foreground
  mutedBreakWordsRelaxed: {
    marginTop: space.xs,
    overflowWrap: "break-word",
    fontSize: "11px",
    lineHeight: "1.625",
    color: colors.mutedForeground,
  },
  // mt-2 border-l-2 border-[#E8E044]/70 pl-2.5
  mt2BorderL2Border70: {
    marginTop: space.md,
    borderLeftWidth: "2px",
    borderColor: "rgb(232 224 68 / 0.7)",
    paddingLeft: "0.625rem",
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
    marginTop: space.xs,
    overflowWrap: "break-word",
    fontSize: "11px",
    lineHeight: "1.625",
    color: "hsl(var(--foreground) / 0.85)",
  },
  // block w-full px-3 py-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset
  blockWide: {
    display: "block",
    width: "100%",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.lg,
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
      ":focus-visible": "inset 0 0 0 2px hsl(var(--ring))",
    },
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--muted) / 0.5)",
    },
  },
  // px-3 py-3
  px3Py3: {
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.lg,
  },
  // h-8 gap-2 rounded-none border bg-card/90 px-3 shadow-sm backdrop-blur border-emerald-400/35 text-emerald-300 hover:bg-emerald-500/10
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.md,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(52 211 153 / 0.35)",
    backgroundColor: {
      default: "hsl(var(--card) / 0.9)",
      ":hover": "rgb(16 185 129 / 0.1)",
    },
    paddingLeft: space.lg,
    paddingRight: space.lg,
    color: "rgb(110 231 183 / 1)",
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
  },
  // h-8 gap-2 rounded-none border bg-card/90 px-3 shadow-sm backdrop-blur border-amber-400/45 text-amber-200 hover:bg-amber-500/10
  borderedGlassyGap22: {
    height: "2rem",
    gap: space.md,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(251 191 36 / 0.45)",
    backgroundColor: {
      default: "hsl(var(--card) / 0.9)",
      ":hover": "rgb(245 158 11 / 0.1)",
    },
    paddingLeft: space.lg,
    paddingRight: space.lg,
    color: "rgb(253 230 138 / 1)",
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
  },
  // mt-0.5 size-3.5 shrink-0 text-destructive
  tightDanger: {
    marginTop: space.xxs,
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: colors.danger,
  },
  // mt-0.5 size-3.5 shrink-0 text-amber-300
  tight: {
    marginTop: space.xxs,
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: "rgb(252 211 77 / 1)",
  },
  /*
   * `divide-y divide-border/70` was a `> * + *` rule, which StyleX cannot
   * express from the parent, so each row draws the hairline above itself and
   * `:first-child` cancels it — exactly the rows the utility selected.
   */
  rowDivided: {
    borderTopWidth: {
      default: "1px",
      ":first-child": "0",
    },
    borderTopColor: "hsl(var(--border) / 0.7)",
  },
});
