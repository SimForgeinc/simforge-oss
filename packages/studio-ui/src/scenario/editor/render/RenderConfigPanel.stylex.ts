import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, stroke, text } from "../../../stylex/tokens.stylex";

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
    lineHeight: text.lineSm,
    fontWeight: text.weightBold,
    letterSpacing: text.trackingTight,
    color: colors.text,
  },
  // mt-0.5 text-micro text-muted-foreground
  microMuted: {
    marginTop: space.s0_5,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // shrink-0 text-micro uppercase tracking-meta text-muted-foreground
  tightCapsMicro: {
    flexShrink: "0",
    color: colors.mutedForeground,
  },
  // flex items-baseline justify-between gap-3 border-b render-hairline py-1.5 last:border-b-0
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s3,
    borderBottomWidth: {
      default: stroke.hairline,
      ":last-child": "0px",
    },
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    borderColor: colors.hairline,
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    color: colors.mutedForeground,
  },
  // min-w-0 truncate text-xs font-semibold text-foreground
  xsInkSemibold: {
    minWidth: "0px",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
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
    gap: space.s4,
    borderBottomWidth: stroke.hairline,
    paddingLeft: space.s6,
    paddingRight: space.s6,
    paddingTop: space.s3,
    paddingBottom: space.s3,
    borderColor: colors.hairline,
  },
  // absolute inset-x-0 top-0 h-px bg-gradient-to-r from-primary/70 via-primary/15 to-transparent
  abs: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: "1px",
    backgroundImage: "linear-gradient(to right, hsl(var(--primary) / 0.7), hsl(var(--primary) / 0.15), transparent)",
  },
  // flex min-w-0 items-center gap-3
  flexCenterNarrowable: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    gap: space.s3,
  },
  // motionStyles.editorMotion + grid size-8 shrink-0 place-items-center border render-hairline render-glass text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  gridCenteredTight: {
    display: "grid",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    placeItems: "center",
    borderWidth: stroke.hairline,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // font-mono text-micro font-bold uppercase tracking-meta text-primary/90
  capsMonoMicro: {
    color: colors.accent,
  },
  // text-base font-extrabold leading-tight tracking-tight text-foreground
  inkBaseExtrabold: {
    fontSize: text.sizeBase,
    lineHeight: text.lineTight,
    fontWeight: "800",
    letterSpacing: text.trackingTight,
    color: colors.text,
  },
  // grid gap-2 sm:grid-cols-3
  gridGap2: {
    display: "grid",
    gap: space.s2,
    gridTemplateColumns: {
      default: null,
      [layout.bpSm]: "repeat(3, minmax(0, 1fr))",
    },
  },
  // mt-5 border border-destructive/40 px-3 py-2 text-xs text-muted-foreground
  xsMutedBordered: {
    marginTop: space.s5,
    borderWidth: stroke.hairline,
    borderColor: colors.critical,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // mt-5 border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground
  xsMutedBordered2: {
    marginTop: space.s5,
    borderWidth: stroke.hairline,
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.accentWash,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // render-glass border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground
  xsMutedBordered3: {
    borderWidth: stroke.hairline,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2_5,
    paddingBottom: space.s2_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineRelaxed,
    color: colors.mutedForeground,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // mt-3 grid gap-1.5 text-xs sm:grid-cols-2
  gridXsGap15: {
    marginTop: space.s3,
    display: "grid",
    gap: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    gridTemplateColumns: {
      default: null,
      [layout.bpSm]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // flex items-baseline justify-between gap-2 render-glass border px-3 py-2
  flexBetweenBaseline2: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
    borderWidth: stroke.hairline,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // font-semibold text-foreground
  inkSemibold: {
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // text-micro text-muted-foreground
  microMuted2: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // mt-3 break-words text-xs text-destructive
  xsDangerBreakWords: {
    marginTop: space.s3,
    overflowWrap: "break-word",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
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
    gap: space.s1_5,
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
    gap: space.s2_5,
  },
  // mt-0.5 size-3.5 accent-primary
  mt05Size35AccentPrimary: {
    marginTop: space.s0_5,
    width: "0.875rem",
    height: "0.875rem",
    accentColor: colors.primary,
  },
  // mt-0.5 size-3.5 shrink-0 text-primary
  tightAccent: {
    marginTop: space.s0_5,
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: colors.primary,
  },
  // block truncate text-xs font-semibold text-foreground
  blockXsInk: {
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // block truncate text-micro uppercase tracking-meta text-muted-foreground
  blockCapsMicro: {
    display: "block",
    color: colors.mutedForeground,
  },
  // mt-2 flex flex-wrap gap-1 pl-6
  flexWrapGap1: {
    marginTop: space.s2,
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1,
    paddingLeft: space.s6,
  },
  // border border-dashed render-hairline px-3 py-2 text-xs text-muted-foreground
  xsMutedBordered4: {
    borderWidth: stroke.hairline,
    borderStyle: "dashed",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
    borderColor: colors.hairline,
  },
  // mt-4
  mt4: {
    marginTop: space.s4,
  },
  // flex flex-wrap gap-1.5
  flexWrapGap15: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1_5,
  },
  // grid gap-1.5 sm:grid-cols-3
  gridGap152: {
    display: "grid",
    gap: space.s1_5,
    gridTemplateColumns: {
      default: null,
      [layout.bpSm]: "repeat(3, minmax(0, 1fr))",
    },
  },
  // grid gap-5 lg:grid-cols-[1fr_1.25fr]
  gridGap5: {
    display: "grid",
    gap: space.s5,
    gridTemplateColumns: {
      default: null,
      [layout.bpLg]: "1fr 1.25fr",
    },
  },
  // grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3
  gridXsGap2: {
    display: "grid",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
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
    gap: space.s1,
  },
  // render-glass border px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  inkBordered: {
    borderWidth: stroke.hairline,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    color: colors.text,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // render-glass border px-2 py-1.5 capitalize text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  capsInkBordered: {
    borderWidth: stroke.hairline,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    textTransform: "capitalize",
    color: colors.text,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // capitalize
  caps: {
    textTransform: "capitalize",
  },
  // mt-5 flex items-center gap-2 border border-primary/30 bg-primary/5 px-3 py-2
  flexCenterBordered: {
    marginTop: space.s5,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.accentWash,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
  },
  // size-3.5 shrink-0 text-primary/80
  tight: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
    color: colors.accent,
  },
  // text-xs text-foreground
  xsInk: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.text,
  },
  // ml-2 text-micro font-normal uppercase tracking-meta text-muted-foreground
  capsMicroMuted2: {
    marginLeft: space.s2,
    color: colors.mutedForeground,
  },
  // render-glass border px-3 py-1.5
  bordered: {
    borderWidth: stroke.hairline,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // mt-3 border border-amber-500/45 bg-amber-500/10 px-3 py-2.5
  bordered2: {
    marginTop: space.s3,
    borderWidth: stroke.hairline,
    borderColor: colors.warning,
    backgroundColor: colors.warningWash,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2_5,
    paddingBottom: space.s2_5,
  },
  // flex items-center gap-2 text-amber-700 dark:text-amber-300
  flexCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    color: colors.warning,
  },
  // size-4 shrink-0
  tight2: {
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
  },
  /*
   * `space-y-*` is a `> * + *` rule with no StyleX form — StyleX styles only
   * the element they are applied to — so the margin it handed down now sits on
   * the child that received it, and only the first child goes without.
   */
  // mt-2
  listMt2: {
    marginTop: space.s2,
  },
  // (was the warnings list's space-y-2)
  rowStackedMd: {
    marginTop: space.s2,
  },
  // grid grid-cols-[auto_1fr] gap-x-2 text-xs
  gridXs: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    MozColumnGap: "0.5rem",
    columnGap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  // font-mono text-micro font-bold uppercase text-amber-700 dark:text-amber-300
  capsMonoMicro2: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    color: colors.warning,
  },
  // ml-1 font-mono text-micro font-normal text-muted-foreground
  monoMicroMuted: {
    marginLeft: space.s1,
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightNormal,
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  muted: {
    color: colors.mutedForeground,
  },
  // mt-1.5 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // mt-2 text-micro text-muted-foreground
  microMuted3: {
    marginTop: space.s2,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // mt-3 border border-destructive/40 px-3 py-2 text-xs text-muted-foreground
  xsMutedBordered5: {
    marginTop: space.s3,
    borderWidth: stroke.hairline,
    borderColor: colors.critical,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // mt-3 render-glass border p-3
  borderedPad3: {
    marginTop: space.s3,
    borderWidth: stroke.hairline,
    padding: space.s3,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // flex items-center gap-2 text-xs font-medium
  flexCenterXs: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
  },
  // min-w-0 flex-1 truncate
  fillTruncateNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // shrink-0 font-mono text-micro text-muted-foreground
  tightMonoMicro: {
    flexShrink: "0",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // mt-1.5 text-micro text-muted-foreground
  microMuted4: {
    marginTop: space.s1_5,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // ml-1 font-mono opacity-80
  mono: {
    marginLeft: space.s1,
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
    gap: space.s2,
    borderWidth: stroke.hairline,
    paddingLeft: space.s5,
    paddingRight: space.s5,
    color: colors.mutedForeground,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // motionStyles.editorMotion + inline-flex h-9 shrink-0 items-center justify-center gap-2 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring bg-primary text-primary-foreground hover:bg-primary/90
  inlineFlexCenterMid2: {
    display: "inline-flex",
    height: "2.25rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    backgroundColor: {
      default: colors.primary,
      ":hover": colors.accent,
    },
    paddingLeft: space.s5,
    paddingRight: space.s5,
    color: colors.primaryForeground,
  },
  // motionStyles.editorMotion + border px-3 py-2 border-primary bg-primary/10
  bordered3: {
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    backgroundColor: colors.accentWash,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
  },
  // motionStyles.editorMotion + border px-3 py-2 render-glass
  bordered4: {
    borderWidth: stroke.hairline,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // border px-1.5 py-0.5 text-micro uppercase tracking-meta border-primary bg-primary text-primary-foreground
  capsMicroBordered: {
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    backgroundColor: colors.primary,
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    color: colors.primaryForeground,
  },
  // border px-1.5 py-0.5 text-micro uppercase tracking-meta render-glass text-muted-foreground
  capsMicroMuted3: {
    borderWidth: stroke.hairline,
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
    color: colors.mutedForeground,
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
  // motionStyles.editorMotion + border px-2.5 py-1 text-micro uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary text-primary-foreground
  capsMicroBordered2: {
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    backgroundColor: colors.primary,
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    color: colors.primaryForeground,
  },
  // motionStyles.editorMotion + border px-2.5 py-1 text-micro uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring render-glass text-muted-foreground hover:text-foreground
  capsMicroMuted4: {
    borderWidth: stroke.hairline,
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: colors.fillSubtle,
    borderColor: colors.hairline,
  },
});
