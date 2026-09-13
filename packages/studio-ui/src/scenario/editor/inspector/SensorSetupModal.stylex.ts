import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // fixed inset-0 z-[90] grid place-items-center p-4 sm:p-6
  fixedGridCentered: {
    position: "fixed",
    inset: space.none,
    zIndex: layers.editorTop,
    display: "grid",
    placeItems: "center",
    padding: {
      default: space.xl,
      "@media (min-width: 640px)": space.xxl,
    },
  },
  // absolute inset-0 cursor-default bg-background/60 backdrop-blur-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  absInset0: {
    position: "absolute",
    inset: space.none,
    cursor: "default",
    backgroundColor: "hsl(var(--background) / 0.6)",
    backdropFilter: "blur(12px)",
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
  // relative flex max-h-[calc(100vh-48px)] w-[min(880px,calc(100vw-32px))] flex-col overflow-hidden border border-border bg-card/90 shadow-2xl backdrop-blur-xl
  relFlexCol: {
    position: "relative",
    display: "flex",
    maxHeight: "calc(100vh - 48px)",
    width: "min(880px, calc(100vw - 32px))",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
    backdropFilter: "blur(24px)",
  },
  // relative flex items-start justify-between gap-4 border-b border-border px-6 py-4
  relFlexBetween: {
    position: "relative",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.xl,
    borderBottomWidth: "1px",
    borderColor: colors.border,
    paddingLeft: space.xxl,
    paddingRight: space.xxl,
    paddingTop: space.xl,
    paddingBottom: space.xl,
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
  // min-w-0
  narrowable: {
    minWidth: "0px",
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
  // mt-1 text-lg font-extrabold leading-tight tracking-tight text-foreground
  lgInkExtrabold: {
    marginTop: space.xs,
    fontSize: text.sizeLg,
    lineHeight: "1.25",
    fontWeight: "800",
    letterSpacing: "-0.025em",
    color: colors.text,
  },
  // mt-0.5 text-xs text-muted-foreground
  xsMuted: {
    marginTop: space.xxs,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  gridCenteredTight: {
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: "0",
    placeItems: "center",
    borderRadius: "0",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
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
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
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
    gap: space.none,
    overflow: "hidden",
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 768px)": "300px minmax(0, 1fr)",
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
      default: "1px",
      "@media (min-width: 768px)": "0px",
    },
    borderColor: colors.border,
    padding: space.xl,
    scrollbarWidth: "thin",
    borderRightWidth: {
      default: null,
      "@media (min-width: 768px)": "1px",
    },
  },
  // font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground
  capsMonoMicro2: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
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
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // block truncate text-micro text-muted-foreground
  blockMicroMuted: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // shrink-0 font-mono text-micro font-bold uppercase tracking-meta text-primary
  tightCapsMono: {
    flexShrink: "0",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.primary,
  },
  // grid grid-cols-3 gap-1.5
  gridCols3Gap15: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.sm,
  },
  // text-micro text-destructive
  microDanger: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.danger,
  },
  // text-xs text-muted-foreground
  xsMuted2: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // flex min-h-0 flex-col overflow-y-auto p-4 [scrollbar-width:thin]
  flexColScrollY: {
    display: "flex",
    minHeight: "0px",
    flexDirection: "column",
    overflowY: "auto",
    padding: space.xl,
    scrollbarWidth: "thin",
  },
  // grid h-[240px] shrink-0 place-items-center border border-border bg-muted/20 p-2
  gridCenteredTight2: {
    display: "grid",
    height: "240px",
    flexShrink: "0",
    placeItems: "center",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.2)",
    padding: space.md,
  },
  // max-w-[24ch] text-center text-xs text-muted-foreground
  xsMutedCenterText: {
    maxWidth: "24ch",
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // mt-4 text-xs text-muted-foreground
  xsMuted3: {
    marginTop: space.xl,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + flex flex-col items-center gap-1 border border-border px-2 py-2 text-micro font-semibold text-foreground hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35
  flexColCenter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.xs,
    borderWidth: "1px",
    borderColor: {
      default: colors.border,
      ":hover": "hsl(var(--primary) / 0.5)",
    },
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
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
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--muted) / 0.4)",
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
  },
  // block truncate text-xs text-foreground
  blockXsInk2: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.text,
  },
  // block truncate font-mono text-micro text-muted-foreground
  blockMonoMicro: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  muted: {
    color: {
      default: colors.mutedForeground,
      ":hover": colors.danger,
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
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
    },
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // mt-4 (was mt-4 space-y-4)
  mt4StackXl: {
    marginTop: space.xl,
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  // block
  block: {
    display: "block",
  },
  // mt-1 h-8 text-xs
  xs: {
    marginTop: space.xs,
    height: "2rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // mt-1 grid grid-cols-2 gap-2
  gridCols2Gap2: {
    marginTop: space.xs,
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
  },
  // border-t border-border pt-3
  ruleT: {
    borderTopWidth: "1px",
    borderColor: colors.border,
    paddingTop: space.lg,
  },
  // motionStyles.editorMotion + font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  capsMonoMicro3: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
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
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
    },
  },
  // mt-2 (was mt-2 space-y-2)
  mt2StackMd: {
    marginTop: space.md,
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  // text-micro text-muted-foreground
  microMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // grid grid-cols-3 gap-2
  gridCols3Gap2: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.md,
  },
  // flex items-baseline justify-between gap-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
  },
  // font-mono text-micro text-muted-foreground
  monoMicroMuted: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // mt-1 flex flex-wrap gap-1
  flexWrapGap1: {
    marginTop: space.xs,
    display: "flex",
    flexWrap: "wrap",
    gap: space.xs,
  },
  // sr-only
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: space.none,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  // relative block
  relBlock: {
    position: "relative",
    display: "block",
  },
  // h-8 pr-12 text-xs
  xs2: {
    height: "2rem",
    paddingRight: "3rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-micro text-muted-foreground
  absMonoMicro: {
    pointerEvents: "none",
    position: "absolute",
    right: space.md,
    top: "50%",
    transform: "translate(0, -50%)",
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + flex w-full items-center gap-3 border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary/10
  flexCenterBordered: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.lg,
    borderWidth: "1px",
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.1)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
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
  // motionStyles.editorMotion + flex w-full items-center gap-3 border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-border hover:border-primary/50 hover:bg-muted/40
  flexCenterBordered2: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.lg,
    borderWidth: "1px",
    borderColor: {
      default: colors.border,
      ":hover": "hsl(var(--primary) / 0.5)",
    },
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
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
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--muted) / 0.4)",
    },
  },
  // flex items-center gap-2 border px-2 py-1.5 border-primary bg-primary/10
  flexCenterBordered3: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    borderWidth: "1px",
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.1)",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  // flex items-center gap-2 border px-2 py-1.5 border-border
  flexCenterBordered4: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    borderWidth: "1px",
    borderColor: colors.border,
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  // motionStyles.editorMotion + border px-2 py-1 text-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary/15 text-primary
  microAccentBordered: {
    borderWidth: "1px",
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.15)",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.primary,
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
  // motionStyles.editorMotion + border px-2 py-1 text-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-border text-muted-foreground hover:border-primary/40 hover:text-foreground
  microMutedBordered: {
    borderWidth: "1px",
    borderColor: {
      default: colors.border,
      ":hover": "hsl(var(--primary) / 0.4)",
    },
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
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
      ":focus-visible": "0 0 0 2px hsl(var(--ring))",
    },
  },
  // (was each section's space-y-1.5)
  stackSm: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  // (was the scrolling column's space-y-4, moved onto the sections)
  stackedXl: {
    marginTop: space.xl,
  },
});
