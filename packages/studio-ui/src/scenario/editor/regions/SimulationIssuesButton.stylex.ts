import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // h-8 gap-2 rounded-none border border-border bg-card/90 px-3 shadow-sm backdrop-blur
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.s2,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
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
      "@media (min-width: 640px)": "440px",
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
    borderWidth: "1px",
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
    color: "rgb(52 211 153 / 1)",
  },
  // mt-3 text-sm font-medium text-foreground
  smInkMedium: {
    marginTop: space.s3,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // mt-1 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // border border-dashed border-border p-5 text-center text-xs text-muted-foreground
  xsMutedBordered: {
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: colors.border,
    padding: "1.25rem",
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // flex items-start gap-2.5
  flexStartGap25: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.625rem",
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
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-1 break-words text-xs leading-relaxed text-muted-foreground
  xsMutedBreakWords: {
    marginTop: space.s1,
    overflowWrap: "break-word",
    fontSize: text.sizeXs,
    lineHeight: "1.625",
    color: colors.mutedForeground,
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // text-emerald-400
  textEmerald400: {
    color: "rgb(52 211 153 / 1)",
  },
  // text-destructive
  danger: {
    color: colors.danger,
  },
  // text-amber-300
  textAmber300: {
    color: "rgb(252 211 77 / 1)",
  },
  // border p-3 border-destructive/50 bg-destructive/10
  borderedPad3: {
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.5)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    padding: space.s3,
  },
  // border p-3 border-amber-400/40 bg-amber-500/10
  borderedPad32: {
    borderWidth: "1px",
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
