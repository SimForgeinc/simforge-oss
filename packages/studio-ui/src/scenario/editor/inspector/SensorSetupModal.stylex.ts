import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // fixed inset-0 z-[90] grid place-items-center p-4 sm:p-6
  fixedGridCentered: {
    position: "fixed",
    inset: 0,
    zIndex: layers.editorTop,
    display: "grid",
    placeItems: "center",
    padding: {
      default: space.s4,
      [layout.bpSm]: space.s6,
    },
  },
  // absolute inset-0 cursor-default bg-background/60 backdrop-blur-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  absInset0: {
    position: "absolute",
    inset: 0,
    cursor: "default",
    backgroundColor: "hsl(var(--background) / 0.6)",
    backdropFilter: motion.blurGlass,
  },
  // relative flex max-h-[calc(100vh-48px)] w-[min(880px,calc(100vw-32px))] flex-col overflow-hidden border border-border bg-card/90 shadow-2xl backdrop-blur-xl
  relFlexCol: {
    position: "relative",
    display: "flex",
    maxHeight: "calc(100vh - 48px)",
    width: "min(880px, calc(100vw - 32px))",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: "hsl(var(--card) / 0.9)",
    boxShadow: shadows.elevation2xl,
    backdropFilter: motion.blurPane,
  },
  // relative flex items-start justify-between gap-4 border-b border-border px-6 py-4
  relFlexBetween: {
    position: "relative",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.s4,
    borderBottomWidth: stroke.hairline,
    borderColor: colors.hairline,
    paddingLeft: space.s6,
    paddingRight: space.s6,
    paddingTop: space.s4,
    paddingBottom: space.s4,
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
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // font-mono text-micro font-bold uppercase tracking-meta text-primary/90
  capsMonoMicro: {
    color: colors.accent,
  },
  // mt-1 text-lg font-extrabold leading-tight tracking-tight text-foreground
  lgInkExtrabold: {
    marginTop: space.s1,
    fontSize: text.sizeLg,
    lineHeight: text.lineTight,
    fontWeight: "800",
    letterSpacing: text.trackingTight,
    color: colors.text,
  },
  // mt-0.5 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.s0_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  gridCenteredTight: {
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: "0",
    placeItems: "center",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    backgroundColor: {
      default: null,
      ":hover": colors.muted,
    },
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // grid min-h-0 flex-1 gap-0 overflow-hidden md:grid-cols-[300px_minmax(0,1fr)]
  gridFillClip: {
    display: "grid",
    minHeight: "0px",
    flex: "1 1 0%",
    gap: 0,
    overflow: "hidden",
    gridTemplateColumns: {
      default: null,
      [layout.bpMd]: "300px minmax(0, 1fr)",
    },
  },
  /*
   * `space-y-*` is a `> * + *` sibling rule, which StyleX cannot express: a
   * style only ever reaches the element it is applied to. Two replacements,
   * both exact.
   *
   * `stackedXl` / `stackedMd` put the margin the parent handed down onto the
   * child that received it. This is what the scrolling left column uses,
   * because turning a column that scrolls into a flex container also makes its
   * children flex items, and their shrinking is then the flex algorithm's
   * business rather than the scroller's.
   *
   * `stackSm` / `stackXl` / `stackMd` are `flex`/`column`/`gap` instead, used
   * where every child is already a block-level box with no vertical margin of
   * its own — same boxes, same distances, nothing to blockify.
   */
  // min-h-0 overflow-y-auto border-b border-border p-4 md:border-b-0 md:border-r [scrollbar-width:thin]
  ruleBScrollYShrinkable: {
    minHeight: "0px",
    overflowY: "auto",
    borderBottomWidth: {
      default: stroke.hairline,
      [layout.bpMd]: "0px",
    },
    borderColor: colors.hairline,
    padding: space.s4,
    scrollbarWidth: "thin",
    borderRightWidth: {
      default: null,
      [layout.bpMd]: stroke.hairline,
    },
  },
  // font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground
  capsMonoMicro2: {
    color: colors.mutedForeground,
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // block truncate text-xs font-semibold text-foreground
  blockXsInk: {
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // block truncate text-micro text-muted-foreground
  blockMicroMuted: {
    display: "block",
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // shrink-0 font-mono text-micro font-bold uppercase tracking-meta text-primary
  tightCapsMono: {
    flexShrink: "0",
    color: colors.primary,
  },
  // grid grid-cols-3 gap-1.5
  gridCols3Gap15: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.s1_5,
  },
  // text-micro text-destructive
  microDanger: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.danger,
  },
  // text-xs text-muted-foreground
  xsMuted2: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // flex min-h-0 flex-col overflow-y-auto p-4 [scrollbar-width:thin]
  flexColScrollY: {
    display: "flex",
    minHeight: "0px",
    flexDirection: "column",
    overflowY: "auto",
    padding: space.s4,
    scrollbarWidth: "thin",
  },
  // grid h-[240px] shrink-0 place-items-center border border-border bg-muted/20 p-2
  gridCenteredTight2: {
    display: "grid",
    height: "240px",
    flexShrink: "0",
    placeItems: "center",
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: colors.fillFaint,
    padding: space.s2,
  },
  // max-w-[24ch] text-center text-xs text-muted-foreground
  xsMutedCenterText: {
    maxWidth: "24ch",
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // mt-4 text-xs text-muted-foreground
  xsMuted3: {
    marginTop: space.s4,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + flex flex-col items-center gap-1 border border-border px-2 py-2 text-micro font-semibold text-foreground hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35
  flexColCenter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s1,
    borderWidth: stroke.hairline,
    borderColor: {
      default: colors.hairline,
      ":hover": colors.accentLine,
    },
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightSemibold,
    color: colors.text,
    cursor: {
      default: null,
      ":disabled": "not-allowed",
    },
    opacity: {
      default: null,
      ":disabled": "0.35",
    },
    backgroundColor: {
      default: null,
      ":hover": colors.fillSubtle,
    },
  },
  // relative
  rel: {
    position: "relative",
  },
  // absolute -right-1.5 -top-1 size-2.5 text-primary
  absAccent: {
    position: "absolute",
    right: "-0.375rem",
    top: "-0.25rem",
    width: "0.625rem",
    height: "0.625rem",
    color: colors.primary,
  },
  // min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring
  fillNarrowableLeftText: {
    minWidth: "0px",
    flex: "1 1 0%",
    textAlign: "left",
  },
  // block truncate text-xs text-foreground
  blockXsInk2: {
    display: "block",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.text,
  },
  // block truncate font-mono text-micro text-muted-foreground
  blockMonoMicro: {
    display: "block",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  muted: {
    color: {
      default: colors.mutedForeground,
      ":hover": colors.danger,
    },
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // mt-4 (was mt-4 space-y-4)
  mt4StackXl: {
    marginTop: space.s4,
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
  },
  // block
  block: {
    display: "block",
  },
  // mt-1 h-8 text-xs
  xs: {
    marginTop: space.s1,
  },
  // mt-1 grid grid-cols-2 gap-2
  gridCols2Gap2: {
    marginTop: space.s1,
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s2,
  },
  // border-t border-border pt-3
  ruleT: {
    borderTopWidth: stroke.hairline,
    borderColor: colors.hairline,
    paddingTop: space.s3,
  },
  // motionStyles.editorMotion + font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  capsMonoMicro3: {
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
  // mt-2 (was mt-2 space-y-2)
  mt2StackMd: {
    marginTop: space.s2,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  // text-micro text-muted-foreground
  microMuted: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // grid grid-cols-3 gap-2
  gridCols3Gap2: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.s2,
  },
  // flex items-baseline justify-between gap-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
  },
  // font-mono text-micro text-muted-foreground
  monoMicroMuted: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // mt-1 flex flex-wrap gap-1
  flexWrapGap1: {
    marginTop: space.s1,
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1,
  },
  // relative block
  relBlock: {
    position: "relative",
    display: "block",
  },
  // h-8 pr-12 text-xs
  xs2: {
    paddingRight: space.s12,
  },
  // pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-micro text-muted-foreground
  absMonoMicro: {
    pointerEvents: "none",
    position: "absolute",
    right: space.s2,
    top: "50%",
    transform: "translate(0, -50%)",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + flex w-full items-center gap-3 border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary/10
  flexCenterBordered: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s3,
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    backgroundColor: colors.accentWash,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    textAlign: "left",
  },
  // motionStyles.editorMotion + flex w-full items-center gap-3 border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-border hover:border-primary/50 hover:bg-muted/40
  flexCenterBordered2: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s3,
    borderWidth: stroke.hairline,
    borderColor: {
      default: colors.hairline,
      ":hover": colors.accentLine,
    },
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    textAlign: "left",
    backgroundColor: {
      default: null,
      ":hover": colors.fillSubtle,
    },
  },
  // flex items-center gap-2 border px-2 py-1.5 border-primary bg-primary/10
  flexCenterBordered3: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    backgroundColor: colors.accentWash,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
  },
  // flex items-center gap-2 border px-2 py-1.5 border-border
  flexCenterBordered4: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
  },
  // motionStyles.editorMotion + border px-2 py-1 text-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary/15 text-primary
  microAccentBordered: {
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    backgroundColor: colors.accentWash,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.primary,
  },
  // motionStyles.editorMotion + border px-2 py-1 text-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-border text-muted-foreground hover:border-primary/40 hover:text-foreground
  microMutedBordered: {
    borderWidth: stroke.hairline,
    borderColor: {
      default: colors.hairline,
      ":hover": colors.accentLineSubtle,
    },
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
  // (was each section's space-y-1.5)
  stackSm: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
  },
  // (was the scrolling column's space-y-4, moved onto the sections)
  stackedXl: {
    marginTop: space.s4,
  },
});
