import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers, motion } from "../../../../stylex/tokens.stylex";

/** `animate-spin`. */
const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

/** `animate-pulse`. */
const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

/** `animate-ping`. */
const ping = stylex.keyframes({
  "75%, 100%": { transform: "scale(2)", opacity: 0 },
});

export const styles = stylex.create({
  // mx-auto mt-6 w-full max-w-4xl text-left
  wideCenteredXLeftText: {
    marginLeft: "auto",
    marginRight: "auto",
    marginTop: space.xxl,
    width: "100%",
    maxWidth: "56rem",
    textAlign: "left",
  },
  // group relative w-full overflow-hidden px-6 py-8 text-left transition duration-300 hover:-translate-y-0.5 focus-visible:rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] sm:px-10
  relClipWide: {
    position: "relative",
    width: "100%",
    overflow: "hidden",
    paddingLeft: {
      default: space.xxl,
      "@media (min-width: 640px)": "2.5rem",
    },
    paddingRight: {
      default: space.xxl,
      "@media (min-width: 640px)": "2.5rem",
    },
    paddingTop: space.xxxl,
    paddingBottom: space.xxxl,
    textAlign: "left",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "300ms",
    animationDuration: "300ms",
    borderRadius: {
      default: null,
      ":focus-visible": "0",
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
    transform: {
      default: null,
      ":hover": "translate(0, -0.125rem)",
    },
  },
  // relative flex items-center gap-5
  relFlexCenter: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "1.25rem",
  },
  // grid size-16 shrink-0 place-items-center text-[#E8E044] transition-transform duration-300 group-hover:scale-105
  gridCenteredTight: {
    display: "grid",
    width: "4rem",
    height: "4rem",
    flexShrink: "0",
    placeItems: "center",
    color: colors.accent,
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "300ms",
    animationDuration: "300ms",
  },
  // size-9
  size9: {
    width: "2.25rem",
    height: "2.25rem",
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // block font-meta text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]
  blockCapsMeta: {
    display: "block",
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.accent,
  },
  // mt-1 block text-xl font-semibold text-white sm:text-2xl
  blockXlWhite: {
    marginTop: space.xs,
    display: "block",
    fontSize: {
      default: text.sizeXl,
      "@media (min-width: 640px)": text.size2xl,
    },
    lineHeight: {
      default: "1.75rem",
      "@media (min-width: 640px)": "2rem",
    },
    fontWeight: text.weightSemibold,
    color: "rgb(255 255 255 / 1)",
  },
  // mt-1 block truncate text-xs text-white/45
  blockXsTruncate: {
    marginTop: space.xs,
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.45)",
  },
  // size-5 shrink-0 text-[#E8E044] transition-transform duration-300 group-hover:translate-x-1
  tight: {
    width: "1.25rem",
    height: "1.25rem",
    flexShrink: "0",
    color: colors.accent,
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "300ms",
    animationDuration: "300ms",
  },
  // mt-2 text-center text-micro text-muted-foreground
  microMutedCenterText: {
    marginTop: space.md,
    textAlign: "center",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // font-semibold text-foreground
  inkSemibold: {
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-3 flex items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs
  flexBetweenStart: {
    marginTop: space.lg,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.lg,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    padding: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // min-w-0 text-destructive
  dangerNarrowable: {
    minWidth: "0px",
    color: colors.danger,
  },
  // block
  block: {
    display: "block",
  },
  // mt-1 block text-[10px] text-destructive/80
  block2: {
    marginTop: space.xs,
    display: "block",
    fontSize: "10px",
    color: "hsl(var(--destructive) / 0.8)",
  },
  // fixed inset-0 z-[220] grid place-items-center overflow-hidden text-white
  fixedGridCentered: {
    position: "fixed",
    inset: space.none,
    zIndex: layers.dialogTop,
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    color: "rgb(255 255 255 / 1)",
  },
  // fixed
  fixed: {
    position: "fixed",
  },
  // absolute right-5 top-5 z-10 gap-2 rounded-full bg-transparent text-white/60 hover:bg-transparent hover:text-white
  absRoundRaised: {
    position: "absolute",
    right: "1.25rem",
    top: "1.25rem",
    zIndex: layers.raised,
    gap: space.md,
    borderRadius: "0",
    backgroundColor: {
      default: "transparent",
      ":hover": "transparent",
    },
    color: {
      default: "rgb(255 255 255 / 0.6)",
      ":hover": "rgb(255 255 255 / 1)",
    },
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // relative z-10 w-full max-w-3xl px-6 py-10 text-center sm:px-10
  relWideRaised: {
    position: "relative",
    zIndex: layers.raised,
    width: "100%",
    maxWidth: "48rem",
    paddingLeft: {
      default: space.xxl,
      "@media (min-width: 640px)": "2.5rem",
    },
    paddingRight: {
      default: space.xxl,
      "@media (min-width: 640px)": "2.5rem",
    },
    paddingTop: "2.5rem",
    paddingBottom: "2.5rem",
    textAlign: "center",
  },
  // relative mx-auto grid size-44 place-items-center sm:size-52
  relGridCentered: {
    position: "relative",
    marginLeft: "auto",
    marginRight: "auto",
    display: "grid",
    width: {
      default: "11rem",
      "@media (min-width: 640px)": "13rem",
    },
    height: {
      default: "11rem",
      "@media (min-width: 640px)": "13rem",
    },
    placeItems: "center",
  },
  // absolute inset-0 animate-spin rounded-full border border-primary/25 border-t-primary [animation-duration:3s]
  absBorderedRound: {
    position: "absolute",
    inset: space.none,
    animationName: spin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "hsl(var(--primary) / 0.25)",
    borderTopColor: colors.primary,
    animationDuration: "3s",
  },
  // absolute inset-5 animate-spin rounded-full border border-dashed border-primary/30 border-b-primary [animation-direction:reverse] [animation-duration:5s]
  absBorderedRound2: {
    position: "absolute",
    inset: "1.25rem",
    animationName: spin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    borderRadius: "0",
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: "hsl(var(--primary) / 0.3)",
    borderBottomColor: colors.primary,
    animationDirection: "reverse",
    animationDuration: "5s",
  },
  // absolute inset-10 animate-pulse rounded-full bg-primary/10
  absRoundPulsing: {
    position: "absolute",
    inset: "2.5rem",
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
    borderRadius: "0",
    backgroundColor: "hsl(var(--primary) / 0.1)",
  },
  // relative grid size-20 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_0_60px_hsl(var(--primary)/.45)]
  relGridCentered2: {
    position: "relative",
    display: "grid",
    width: "5rem",
    height: "5rem",
    placeItems: "center",
    borderRadius: "0",
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    boxShadow: "0 0 60px hsl(var(--primary)/0.45)",
  },
  // size-9 animate-spin
  spinner: {
    width: "2.25rem",
    height: "2.25rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  // size-9 animate-pulse
  pulsing: {
    width: "2.25rem",
    height: "2.25rem",
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
  },
  // mt-8 font-meta text-[10px] font-bold uppercase tracking-[0.28em] text-primary
  capsMetaAccent: {
    marginTop: space.xxxl,
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: "0.28em",
    color: colors.primary,
  },
  // mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl
  xxxlInkSemibold: {
    marginTop: space.md,
    fontSize: {
      default: "1.875rem",
      "@media (min-width: 640px)": "2.25rem",
    },
    lineHeight: {
      default: "2.25rem",
      "@media (min-width: 640px)": "2.5rem",
    },
    fontWeight: text.weightSemibold,
    letterSpacing: "-0.025em",
    color: colors.text,
  },
  // mt-2 text-sm tabular-nums text-muted-foreground
  smMutedNums: {
    marginTop: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontVariantNumeric: "tabular-nums",
    color: colors.mutedForeground,
  },
  // mx-auto mt-9 grid max-w-2xl grid-cols-4 gap-2
  gridCenteredXCols4: {
    marginLeft: "auto",
    marginRight: "auto",
    marginTop: "2.25rem",
    display: "grid",
    maxWidth: "42rem",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: space.md,
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // absolute inset-y-0 left-0 w-1/2 animate-pulse rounded-full bg-primary
  absRoundPulsing2: {
    position: "absolute",
    top: space.none,
    bottom: space.none,
    left: space.none,
    width: "50%",
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
    borderRadius: "0",
    backgroundColor: colors.primary,
  },
  // mt-0.5 text-micro font-semibold tabular-nums text-primary
  microAccentSemibold: {
    marginTop: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightSemibold,
    fontVariantNumeric: "tabular-nums",
    color: colors.primary,
  },
  // fixed inset-0 z-[220] overflow-y-auto text-white
  fixedWhiteScrollY: {
    position: "fixed",
    inset: space.none,
    zIndex: layers.dialogTop,
    overflowY: "auto",
    color: "rgb(255 255 255 / 1)",
  },
  // relative mx-auto flex min-h-full w-full max-w-4xl flex-col items-center justify-center px-5 py-12 text-center
  relFlexCol: {
    position: "relative",
    marginLeft: "auto",
    marginRight: "auto",
    display: "flex",
    minHeight: "100%",
    width: "100%",
    maxWidth: "56rem",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: "1.25rem",
    paddingRight: "1.25rem",
    paddingTop: "3rem",
    paddingBottom: "3rem",
    textAlign: "center",
  },
  // relative grid size-20 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_0_70px_hsl(var(--primary)/.4)]
  relGridCentered3: {
    position: "relative",
    display: "grid",
    width: "5rem",
    height: "5rem",
    placeItems: "center",
    borderRadius: "0",
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    boxShadow: "0 0 70px hsl(var(--primary)/0.4)",
  },
  // absolute inset-0 animate-ping rounded-full border border-primary opacity-25
  absBorderedRound3: {
    position: "absolute",
    inset: space.none,
    animationName: ping,
    animationDuration: "1s",
    animationTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
    animationIterationCount: "infinite",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: colors.primary,
    opacity: "0.25",
  },
  // mt-7 font-meta text-[10px] font-bold uppercase tracking-[0.28em] text-primary
  capsMetaAccent2: {
    marginTop: "1.75rem",
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: "0.28em",
    color: colors.primary,
  },
  // mt-2 text-4xl font-semibold tracking-tight text-foreground sm:text-6xl
  hugeInkSemibold: {
    marginTop: space.md,
    fontSize: {
      default: "2.25rem",
      "@media (min-width: 640px)": "3.75rem",
    },
    lineHeight: {
      default: "2.5rem",
      "@media (min-width: 640px)": "1",
    },
    fontWeight: text.weightSemibold,
    letterSpacing: "-0.025em",
    color: colors.text,
  },
  // mt-5 flex items-center justify-center gap-6 text-sm text-muted-foreground
  flexCenterMid: {
    marginTop: "1.25rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xxl,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // text-xl font-semibold tabular-nums text-foreground
  xlInkSemibold: {
    fontSize: text.sizeXl,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
    fontVariantNumeric: "tabular-nums",
    color: colors.text,
  },
  // h-8 w-px bg-border
  h8WPxBgBorder: {
    height: "2rem",
    width: "1px",
    backgroundColor: colors.border,
  },
  // mt-8 h-12 min-w-64 gap-2 rounded-full bg-[#E8E044] px-8 text-sm text-black hover:bg-[#f1ea55] focus-visible:ring-[#E8E044]
  smRoundGap2: {
    marginTop: space.xxxl,
    height: "3rem",
    minWidth: "16rem",
    gap: space.md,
    borderRadius: "0",
    backgroundColor: {
      default: colors.accent,
      ":hover": colors.accentHover,
    },
    paddingLeft: space.xxxl,
    paddingRight: space.xxxl,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: "rgb(0 0 0 / 1)",
    // `focus-visible:ring-[#E8E044]` recoloured only the ring; Button's base
    // rule owns the width, offset and composed box-shadow. Overriding the
    // same custom property keeps that composition intact, so this rule must
    // reach the element through `xstyle` (StyleX merge order), not `className`.
    "--tw-ring-color": { default: null, ":focus-visible": colors.accent },
  },
  // mt-9 w-full max-w-3xl
  wide: {
    marginTop: "2.25rem",
    width: "100%",
    maxWidth: "48rem",
  },
  // flex items-center gap-4
  flexCenterGap4: {
    display: "flex",
    alignItems: "center",
    gap: space.xl,
  },
  // h-px flex-1 bg-border
  fill: {
    height: "1px",
    flex: "1 1 0%",
    backgroundColor: colors.border,
  },
  // font-meta text-[10px] font-bold uppercase tracking-meta-wider text-muted-foreground
  capsMetaMuted: {
    fontFamily: text.fontMeta,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.mutedForeground,
  },
  // mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4
  gridGap2: {
    marginTop: space.xl,
    display: "grid",
    gap: space.md,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
      "@media (min-width: 1024px)": "repeat(4, minmax(0, 1fr))",
    },
  },
  // flex items-start justify-between gap-2
  flexBetweenStart2: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.md,
  },
  // text-sm font-semibold text-foreground
  smInkSemibold: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // rounded-full bg-primary/15 px-1.5 py-0.5 font-meta text-[8px] font-bold uppercase tracking-meta text-primary
  capsMetaAccent3: {
    borderRadius: "0",
    backgroundColor: "hsl(var(--primary) / 0.15)",
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontFamily: text.fontMeta,
    fontSize: "8px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primary,
  },
  // rounded-full border border-border px-1.5 py-0.5 font-meta text-[8px] font-bold uppercase tracking-meta text-muted-foreground
  capsMetaMuted2: {
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: colors.border,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontFamily: text.fontMeta,
    fontSize: "8px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-3 block text-micro tabular-nums text-muted-foreground
  blockMicroMuted: {
    marginTop: space.lg,
    display: "block",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontVariantNumeric: "tabular-nums",
    color: colors.mutedForeground,
  },
  // mt-8 w-full max-w-3xl rounded-xl border border-border bg-card/70 text-left
  borderedWideLeftText: {
    marginTop: space.xxxl,
    width: "100%",
    maxWidth: "48rem",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.7)",
    textAlign: "left",
  },
  // cursor-pointer list-none px-4 py-3 text-xs font-semibold text-muted-foreground hover:text-foreground
  xsMutedSemibold: {
    cursor: "pointer",
    listStyleType: "none",
    paddingLeft: space.xl,
    paddingRight: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
  /*
   * The details body and the results list were `space-y-3` / `space-y-2`, a
   * `> * + *` rule with no StyleX form. Every child of both is a block-level
   * section, article or div with no vertical margin of its own, so a flex
   * column with the same gap places them identically.
   */
  // border-t border-border p-4
  ruleTPad4: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    borderTopWidth: "1px",
    borderColor: colors.border,
    padding: space.xl,
  },
  // (was the results list's space-y-2)
  stackMd: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  // rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs
  xsBorderedPad3: {
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.4)",
    backgroundColor: "hsl(var(--destructive) / 0.05)",
    padding: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // flex items-center justify-between gap-3
  flexCenterBetween: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
  },
  // text-destructive
  danger: {
    color: colors.danger,
  },
  // mt-1 text-micro text-muted-foreground
  microMuted: {
    marginTop: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // flex flex-wrap gap-2
  flexWrapGap2: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.md,
  },
  // gap-2
  gap2: {
    gap: space.md,
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // border border-border bg-surface-raised p-3
  borderedPad3: {
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: space.lg,
  },
  // font-meta text-micro font-bold uppercase tracking-meta text-muted-foreground
  capsMetaMicro: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-micro sm:grid-cols-3
  gridMicroCols2: {
    marginTop: space.md,
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      "@media (min-width: 640px)": "repeat(3, minmax(0, 1fr))",
    },
    MozColumnGap: "1rem",
    columnGap: space.xl,
    rowGap: space.md,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
  },
  // mt-2 border-t border-border/60 pt-2 text-micro
  microRuleT: {
    marginTop: space.md,
    borderTopWidth: "1px",
    borderColor: "hsl(var(--border) / 0.6)",
    paddingTop: space.md,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
  },
  // text-muted-foreground
  muted: {
    color: colors.mutedForeground,
  },
  // mt-0.5 break-words font-medium text-foreground
  inkMediumBreakWords: {
    marginTop: space.xxs,
    overflowWrap: "break-word",
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // flex items-center justify-between gap-2
  flexCenterBetween2: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  // bg-primary px-1.5 py-0.5 font-meta text-[9px] font-bold uppercase text-primary-foreground
  capsMetaBold: {
    backgroundColor: colors.primary,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    color: colors.primaryForeground,
  },
  // mt-2 grid grid-cols-4 gap-2
  gridCols4Gap2: {
    marginTop: space.md,
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: space.md,
  },
  // mt-2 text-micro text-muted-foreground
  microMuted2: {
    marginTop: space.md,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // text-[9px] uppercase tracking-meta text-muted-foreground
  capsMuted: {
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-0.5 text-micro font-semibold tabular-nums text-foreground
  microInkSemibold: {
    marginTop: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightSemibold,
    fontVariantNumeric: "tabular-nums",
    color: colors.text,
  },
  // pointer-events-none fixed left-[-10000px] top-0 h-[720px] w-[1280px] overflow-hidden opacity-0
  fixedClipInert: {
    pointerEvents: "none",
    position: "fixed",
    left: "-10000px",
    top: space.none,
    height: "720px",
    width: "1280px",
    overflow: "hidden",
    opacity: "0",
  },
  // mt-2 truncate text-[10px] text-muted-foreground font-semibold text-foreground
  mutedInkSemibold: {
    marginTop: space.md,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    color: colors.mutedForeground,
  },
  // mt-2 truncate text-[10px] text-muted-foreground
  mutedTruncate: {
    marginTop: space.md,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "10px",
    color: colors.mutedForeground,
  },
  // group min-h-24 p-3 text-left transition hover:-translate-y-0.5 focus-visible:rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] text-[#E8E044]
  pad3LeftText: {
    minHeight: "6rem",
    padding: space.lg,
    textAlign: "left",
    color: colors.accent,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
    borderRadius: {
      default: null,
      ":focus-visible": "0",
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
    transform: {
      default: null,
      ":hover": "translate(0, -0.125rem)",
    },
  },
  // group min-h-24 p-3 text-left transition hover:-translate-y-0.5 focus-visible:rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] text-white/70
  pad3LeftText2: {
    minHeight: "6rem",
    padding: space.lg,
    textAlign: "left",
    color: "rgb(255 255 255 / 0.7)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
    borderRadius: {
      default: null,
      ":focus-visible": "0",
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
    transform: {
      default: null,
      ":hover": "translate(0, -0.125rem)",
    },
  },
  // border p-3 border-primary/60 bg-primary/10
  borderedPad32: {
    borderWidth: "1px",
    borderColor: "hsl(var(--primary) / 0.6)",
    backgroundColor: "hsl(var(--primary) / 0.1)",
    padding: space.lg,
  },
  // border p-3 border-border bg-card
  borderedPad33: {
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: space.lg,
  },
  // relative h-2 overflow-hidden rounded-full bg-border/70
  relClipRound: {
    position: "relative",
    height: "0.5rem",
    overflow: "hidden",
    borderRadius: "0",
    backgroundColor: "hsl(var(--border) / 0.7)",
  },
  // bg-primary
  bgPrimary: {
    backgroundColor: colors.primary,
  },
  // bg-destructive/70
  bgDestructive70: {
    backgroundColor: "hsl(var(--destructive) / 0.7)",
  },
});
