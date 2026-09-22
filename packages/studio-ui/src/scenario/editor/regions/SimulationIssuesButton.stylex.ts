import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // h-8 gap-2 rounded-none border border-border bg-card/90 px-3 shadow-sm backdrop-blur
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    boxShadow: shadows.elevationSm,
    backdropFilter: motion.blurMd,
  },
  // font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground
  capsMonoMuted: {
    fontFamily: text.fontMono,
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: colors.mutedForeground,
  },
  // flex w-[min(440px,calc(100vw-1rem))] flex-col gap-0 overflow-hidden border-border bg-background p-0 sm:max-w-[440px]
  flexColClip: {
    display: "flex",
    width: "min(440px, calc(100vw - 1rem))",
    flexDirection: "column",
    gap: 0,
    overflow: "hidden",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: 0,
    maxWidth: {
      default: null,
      [layout.bpSm]: "440px",
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
  // min-h-0 flex-1 overflow-y-auto p-4
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    padding: space.s4,
  },
  // grid w-full grid-cols-2
  gridWideCols2: {
    display: "grid",
    width: "100%",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  },
  // grid min-h-48 place-items-center border border-dashed border-border p-6 text-center
  gridCenteredBordered: {
    display: "grid",
    minHeight: "12rem",
    placeItems: "center",
    borderWidth: stroke.hairline,
    borderStyle: "dashed",
    borderColor: colors.border,
    padding: space.s6,
    textAlign: "center",
  },
  // mx-auto size-6 text-emerald-400
  centeredX: {
    marginLeft: "auto",
    marginRight: "auto",
    width: "1.5rem",
    height: "1.5rem",
    color: colors.positive,
  },
  // mt-3 text-sm font-medium text-foreground
  smInkMedium: {
    marginTop: space.s3,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // mt-1 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // border border-dashed border-border p-5 text-center text-xs text-muted-foreground
  xsMutedBordered: {
    borderWidth: stroke.hairline,
    borderStyle: "dashed",
    borderColor: colors.border,
    padding: space.s5,
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // flex items-start gap-2.5
  flexStartGap25: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2_5,
  },
  // mt-0.5 size-4 shrink-0
  tight: {
    marginTop: space.s0_5,
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // text-sm font-semibold text-foreground
  smInkSemibold: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-1 break-words text-xs leading-relaxed text-muted-foreground
  xsMutedBreakWords: {
    marginTop: space.s1,
    overflowWrap: "break-word",
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // text-emerald-400
  textEmerald400: {
    color: colors.positive,
  },
  // text-destructive
  danger: {
    color: colors.danger,
  },
  // text-amber-300
  textAmber300: {
    color: colors.warning,
  },
  // border p-3 border-destructive/50 bg-destructive/10
  borderedPad3: {
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--destructive) / 0.5)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    padding: space.s3,
  },
  // border p-3 border-amber-400/40 bg-amber-500/10
  borderedPad32: {
    borderWidth: stroke.hairline,
    borderColor: "rgb(251 191 36 / 0.4)",
    backgroundColor: "rgb(245 158 11 / 0.1)",
    padding: space.s3,
  },
  /*
   * The old `space-y-3`. `space-y` is a `> * + *` rule with no StyleX
   * form; every child here is a block-level section with no vertical margin of
   * its own, so a flex column with the same gap places them identically.
   */
  stackLg: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
});
