import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

/*
 * `dark:` variants are folded to their dark value throughout this module. The
 * editor only ever renders inside the studio shell, whose `layout.tsx` fixes
 * `dark` on `<html>`, so the light value never painted — and a `dark:` class
 * left beside a compiled rule could not win anyway: StyleX guards its atomic
 * rules with repeated `:not(#\#)`, which outranks `.dark .dark\:text-*`.
 */
export const styles = stylex.create({
  // mb-3 flex shrink-0 items-start justify-between gap-4
  flexBetweenStart: {
    marginBottom: space.lg,
    display: "flex",
    flexShrink: "0",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.xl,
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
    marginTop: space.xxs,
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
  // flex items-baseline justify-between gap-3 border-b render-hairline py-1.5 last:border-b-0
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.lg,
    borderBottomWidth: {
      default: "1px",
      ":last-child": "0px",
    },
    paddingTop: space.sm,
    paddingBottom: space.sm,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // min-w-0 truncate text-xs font-semibold text-foreground
  xsInkSemibold: {
    minWidth: "0px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // render-view-enter flex min-h-0 flex-1 flex-col overflow-hidden
  flexColFill: {
    display: "flex",
    minHeight: "0px",
    flex: "1 1 0%",
    flexDirection: "column",
    overflow: "hidden",
  },
  // relative flex shrink-0 items-center justify-between gap-4 border-b render-hairline px-6 py-3
  relFlexCenter: {
    position: "relative",
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.xl,
    borderBottomWidth: "1px",
    paddingLeft: space.xxl,
    paddingRight: space.xxl,
    paddingTop: space.lg,
    paddingBottom: space.lg,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // absolute inset-x-0 top-0 h-px bg-gradient-to-r from-primary/70 via-primary/15 to-transparent
  abs: {
    position: "absolute",
    left: space.none,
    right: space.none,
    top: space.none,
    height: "1px",
    backgroundImage: "linear-gradient(to right, hsl(var(--primary) / 0.7), hsl(var(--primary) / 0.15), transparent)",
  },
  // flex min-w-0 items-center gap-3
  flexCenterNarrowable: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    gap: space.lg,
  },
  // motionStyles.editorMotion + grid size-8 shrink-0 place-items-center border render-hairline render-glass text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  gridCenteredTight: {
    display: "grid",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    placeItems: "center",
    borderWidth: "1px",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
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
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // font-mono text-micro font-bold uppercase tracking-meta text-primary/90
  capsMonoMicro: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: "hsl(var(--primary) / 0.9)",
  },
  // text-base font-extrabold leading-tight tracking-tight text-foreground
  inkBaseExtrabold: {
    fontSize: text.sizeBase,
    lineHeight: "1.25",
    fontWeight: "800",
    letterSpacing: "-0.025em",
    color: colors.text,
  },
  // grid gap-2 sm:grid-cols-3
  gridGap2: {
    display: "grid",
    gap: space.md,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(3, minmax(0, 1fr))",
    },
  },
  // mt-5 border border-destructive/40 px-3 py-2 text-xs text-muted-foreground
  xsMutedBordered: {
    marginTop: "1.25rem",
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.4)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // mt-5 border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground
  xsMutedBordered2: {
    marginTop: "1.25rem",
    borderWidth: "1px",
    borderColor: "hsl(var(--primary) / 0.3)",
    backgroundColor: "hsl(var(--primary) / 0.05)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // render-glass border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground
  xsMutedBordered3: {
    borderWidth: "1px",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: "0.625rem",
    paddingBottom: "0.625rem",
    fontSize: text.sizeXs,
    lineHeight: "1.625",
    color: colors.mutedForeground,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // mt-3 grid gap-1.5 text-xs sm:grid-cols-2
  gridXsGap15: {
    marginTop: space.lg,
    display: "grid",
    gap: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  // flex items-baseline justify-between gap-2 render-glass border px-3 py-2
  flexBetweenBaseline2: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
    borderWidth: "1px",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // font-semibold text-foreground
  inkSemibold: {
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // text-micro text-muted-foreground
  microMuted2: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // mt-3 break-words text-xs text-destructive
  xsDangerBreakWords: {
    marginTop: space.lg,
    overflowWrap: "break-word",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3
  gridGap15: {
    display: "grid",
    gap: space.sm,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
      "@media (min-width: 1280px)": "repeat(3, minmax(0, 1fr))",
    },
  },
  // flex cursor-pointer items-start gap-2.5
  flexStartPointer: {
    display: "flex",
    cursor: "pointer",
    alignItems: "flex-start",
    gap: "0.625rem",
  },
  // mt-0.5 size-3.5 accent-primary
  mt05Size35AccentPrimary: {
    marginTop: space.xxs,
    width: "0.875rem",
    height: "0.875rem",
    accentColor: colors.primary,
  },
  // mt-0.5 size-3.5 shrink-0 text-primary
  tightAccent: {
    marginTop: space.xxs,
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: colors.primary,
  },
  // block truncate text-xs font-semibold text-foreground
  blockXsInk: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // block truncate text-micro uppercase tracking-meta text-muted-foreground
  blockCapsMicro: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-2 flex flex-wrap gap-1 pl-6
  flexWrapGap1: {
    marginTop: space.md,
    display: "flex",
    flexWrap: "wrap",
    gap: space.xs,
    paddingLeft: space.xxl,
  },
  // border border-dashed render-hairline px-3 py-2 text-xs text-muted-foreground
  xsMutedBordered4: {
    borderWidth: "1px",
    borderStyle: "dashed",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // mt-4
  mt4: {
    marginTop: space.xl,
  },
  // flex flex-wrap gap-1.5
  flexWrapGap15: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.sm,
  },
  // grid gap-1.5 sm:grid-cols-3
  gridGap152: {
    display: "grid",
    gap: space.sm,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(3, minmax(0, 1fr))",
    },
  },
  // grid gap-5 lg:grid-cols-[1fr_1.25fr]
  gridGap5: {
    display: "grid",
    gap: "1.25rem",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 1024px)": "1fr 1.25fr",
    },
  },
  // grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3
  gridXsGap2: {
    display: "grid",
    gap: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(3, minmax(0, 1fr))",
      "@media (min-width: 1024px)": "repeat(1, minmax(0, 1fr))",
      "@media (min-width: 1280px)": "repeat(3, minmax(0, 1fr))",
    },
  },
  // flex flex-col gap-1
  flexColGap1: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // render-glass border px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  inkBordered: {
    borderWidth: "1px",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    color: colors.text,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
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
  // render-glass border px-2 py-1.5 capitalize text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  capsInkBordered: {
    borderWidth: "1px",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    textTransform: "capitalize",
    color: colors.text,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
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
  // capitalize
  caps: {
    textTransform: "capitalize",
  },
  // mt-5 flex items-center gap-2 border border-primary/30 bg-primary/5 px-3 py-2
  flexCenterBordered: {
    marginTop: "1.25rem",
    display: "flex",
    alignItems: "center",
    gap: space.md,
    borderWidth: "1px",
    borderColor: "hsl(var(--primary) / 0.3)",
    backgroundColor: "hsl(var(--primary) / 0.05)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  // size-3.5 shrink-0 text-primary/80
  tight: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: "hsl(var(--primary) / 0.8)",
  },
  // text-xs text-foreground
  xsInk: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.text,
  },
  // ml-2 text-micro font-normal uppercase tracking-meta text-muted-foreground
  capsMicroMuted2: {
    marginLeft: space.md,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightNormal,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // render-glass border px-3 py-1.5
  bordered: {
    borderWidth: "1px",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // mt-3 border border-amber-500/45 bg-amber-500/10 px-3 py-2.5
  bordered2: {
    marginTop: space.lg,
    borderWidth: "1px",
    borderColor: "rgb(245 158 11 / 0.45)",
    backgroundColor: "rgb(245 158 11 / 0.1)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: "0.625rem",
    paddingBottom: "0.625rem",
  },
  // flex items-center gap-2 text-amber-700 dark:text-amber-300
  flexCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    color: "rgb(252 211 77 / 1)",
  },
  // size-4 shrink-0
  tight2: {
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
  },
  // text-micro font-bold uppercase tracking-meta
  capsMicroBold: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
  /*
   * `space-y-*` is a `> * + *` rule with no StyleX form — StyleX styles only
   * the element they are applied to — so the margin it handed down now sits on
   * the child that received it, and only the first child goes without.
   */
  // mt-2
  listMt2: {
    marginTop: space.md,
  },
  // (was the warnings list's space-y-2)
  rowStackedMd: {
    marginTop: space.md,
  },
  // grid grid-cols-[auto_1fr] gap-x-2 text-xs
  gridXs: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    MozColumnGap: "0.5rem",
    columnGap: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // font-mono text-micro font-bold uppercase text-amber-700 dark:text-amber-300
  capsMonoMicro2: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    color: "rgb(252 211 77 / 1)",
  },
  // ml-1 font-mono text-micro font-normal text-muted-foreground
  monoMicroMuted: {
    marginLeft: space.xs,
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightNormal,
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  muted: {
    color: colors.mutedForeground,
  },
  // mt-1.5 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // mt-2 text-micro text-muted-foreground
  microMuted3: {
    marginTop: space.md,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // mt-3 border border-destructive/40 px-3 py-2 text-xs text-muted-foreground
  xsMutedBordered5: {
    marginTop: space.lg,
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.4)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // mt-3 render-glass border p-3
  borderedPad3: {
    marginTop: space.lg,
    borderWidth: "1px",
    padding: space.lg,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // flex items-center gap-2 text-xs font-medium
  flexCenterXs: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
  },
  // min-w-0 flex-1 truncate
  fillTruncateNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // shrink-0 font-mono text-micro text-muted-foreground
  tightMonoMicro: {
    flexShrink: "0",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // mt-1.5 text-micro text-muted-foreground
  microMuted4: {
    marginTop: space.sm,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // ml-1 font-mono opacity-80
  mono: {
    marginLeft: space.xs,
    fontFamily: text.fontMono,
    opacity: "0.8",
  },
  // motionStyles.editorMotion + inline-flex h-9 shrink-0 items-center justify-center gap-2 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-not-allowed render-glass border text-muted-foreground
  inlineFlexCenterMid: {
    display: "inline-flex",
    height: "2.25rem",
    flexShrink: "0",
    cursor: "not-allowed",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    borderWidth: "1px",
    paddingLeft: "1.25rem",
    paddingRight: "1.25rem",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
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
  // motionStyles.editorMotion + inline-flex h-9 shrink-0 items-center justify-center gap-2 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring bg-primary text-primary-foreground hover:bg-primary/90
  inlineFlexCenterMid2: {
    display: "inline-flex",
    height: "2.25rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    backgroundColor: {
      default: colors.primary,
      ":hover": "hsl(var(--primary) / 0.9)",
    },
    paddingLeft: "1.25rem",
    paddingRight: "1.25rem",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primaryForeground,
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
  // motionStyles.editorMotion + border px-3 py-2 border-primary bg-primary/10
  bordered3: {
    borderWidth: "1px",
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.1)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  // motionStyles.editorMotion + border px-3 py-2 render-glass
  bordered4: {
    borderWidth: "1px",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // border px-1.5 py-0.5 text-micro uppercase tracking-meta border-primary bg-primary text-primary-foreground
  capsMicroBordered: {
    borderWidth: "1px",
    borderColor: colors.primary,
    backgroundColor: colors.primary,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primaryForeground,
  },
  // border px-1.5 py-0.5 text-micro uppercase tracking-meta render-glass text-muted-foreground
  capsMicroMuted3: {
    borderWidth: "1px",
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // motionStyles.editorMotion + border px-2.5 py-1 text-micro uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary text-primary-foreground
  capsMicroBordered2: {
    borderWidth: "1px",
    borderColor: colors.primary,
    backgroundColor: colors.primary,
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primaryForeground,
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
  // motionStyles.editorMotion + border px-2.5 py-1 text-micro uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring render-glass text-muted-foreground hover:text-foreground
  capsMicroMuted4: {
    borderWidth: "1px",
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: colors.glass,
    borderColor: "rgb(255 255 255 / 10%)",
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
});
