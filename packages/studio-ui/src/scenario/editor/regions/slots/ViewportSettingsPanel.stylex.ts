import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, shadows, space, stroke, text } from "../../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // absolute right-4 top-4
  abs: {
    position: "absolute",
    right: space.s4,
    top: space.s4,
  },
  // flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1.5
  flexCenterBetween: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    borderBottomWidth: stroke.hairline,
    borderColor: colors.border,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
  },
  // font-meta text-micro uppercase tracking-meta-wider text-muted-foreground
  capsMetaMicro: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.mutedForeground,
  },
  // flex items-center gap-0.5
  flexCenterGap05: {
    display: "flex",
    alignItems: "center",
    gap: space.s0_5,
  },
  // size-6
  size6: {
    width: "1.5rem",
    height: "1.5rem",
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // min-h-0 flex-1 overflow-y-auto p-2
  fillScrollYShrinkable: {
    minHeight: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    padding: space.s2,
  },
  // mt-1.5 text-micro leading-snug text-muted-foreground
  microMutedSnug: {
    marginTop: space.s1_5,
    fontSize: text.sizeMicro,
    lineHeight: text.lineSnug,
    color: colors.mutedForeground,
  },
  // grid grid-cols-2 gap-1
  gridCols2Gap1: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s1,
  },
  // w-full justify-start
  startWide: {
    width: "100%",
    justifyContent: "flex-start",
  },
  // flex w-[min(420px,calc(100vw-1rem))] flex-col gap-0 overflow-hidden border-border bg-background p-0 pr-0 sm:max-w-[420px] [&>button:last-child]:hidden
  flexColClip: {
    display: "flex",
    width: "min(420px, calc(100vw - 1rem))",
    flexDirection: "column",
    gap: 0,
    overflow: "hidden",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: 0,
    paddingRight: 0,
    maxWidth: {
      default: null,
      [layout.bpSm]: "420px",
    },
  },
  // mb-1.5 font-meta text-micro uppercase tracking-meta-wider text-muted-foreground/70
  capsMetaMicro2: {
    marginBottom: space.s1_5,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  // flex w-full items-center justify-between gap-2 py-1 text-left text-meta text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  flexCenterBetween2: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    textAlign: "left",
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
  // py-1
  py1: {
    paddingTop: space.s1,
    paddingBottom: space.s1,
  },
  // flex items-baseline justify-between gap-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
  },
  // text-meta text-muted-foreground
  metaMuted: {
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // font-meta text-micro tabular-nums text-muted-foreground/70
  metaMicroNums: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontVariantNumeric: "tabular-nums",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  // mt-1 h-1 w-full cursor-pointer appearance-none bg-muted accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  widePointer: {
    marginTop: space.s1,
    height: "0.25rem",
    width: "100%",
    cursor: "pointer",
    WebkitAppearance: "none",
    MozAppearance: "none",
    appearance: "none",
    backgroundColor: colors.muted,
    accentColor: colors.primary,
  },
  // h-8 border-border bg-card/90 shadow-sm backdrop-blur gap-2 rounded-none px-3
  glassyGap2: {
    height: "2rem",
    gap: space.s2,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    boxShadow: shadows.elevationSm,
    backdropFilter: motion.blurMd,
  },
  // h-8 border-border bg-card/90 shadow-sm backdrop-blur w-8 shadow-xl
  glassy: {
    height: "2rem",
    width: "2rem",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    boxShadow: shadows.elevationXl,
    backdropFilter: motion.blurMd,
  },
  // flex flex-col min-h-0 flex-1
  flexColFill: {
    display: "flex",
    minHeight: "0px",
    flex: "1 1 0%",
    flexDirection: "column",
  },
  // flex flex-col absolute right-4 top-4 max-h-[calc(100%-2rem)] w-[300px] border border-border bg-card/95 shadow-xl backdrop-blur
  absFlexCol: {
    position: "absolute",
    right: space.s4,
    top: space.s4,
    display: "flex",
    maxHeight: "calc(100% - 2rem)",
    width: "300px",
    flexDirection: "column",
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.95)",
    boxShadow: shadows.elevationXl,
    backdropFilter: motion.blurMd,
  },
  // min-h-7 border px-1.5 font-meta text-[9px] font-bold uppercase tracking-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary/15 text-foreground
  capsMetaInk: {
    minHeight: "1.75rem",
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.15)",
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.text,
  },
  // min-h-7 border px-1.5 font-meta text-[9px] font-bold uppercase tracking-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-border bg-surface-raised text-muted-foreground hover:text-foreground
  capsMetaMuted: {
    minHeight: "1.75rem",
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
  // h-7 border font-meta text-micro font-bold uppercase tracking-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary/15 text-foreground
  capsMetaMicro3: {
    height: "1.75rem",
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.15)",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.text,
  },
  // h-7 border font-meta text-micro font-bold uppercase tracking-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-border bg-surface-raised text-muted-foreground hover:text-foreground
  capsMetaMicro4: {
    height: "1.75rem",
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
  },
  // pb-3 mb-3 border-b border-border/60
  ruleB: {
    marginBottom: space.s3,
    borderBottomWidth: stroke.hairline,
    borderColor: "hsl(var(--border) / 0.6)",
    paddingBottom: space.s3,
  },
  // pb-3
  pb3: {
    paddingBottom: space.s3,
  },
  // relative h-3.5 w-7 shrink-0 border transition-colors border-primary bg-primary/30
  relTightBordered: {
    position: "relative",
    height: "0.875rem",
    width: "1.75rem",
    flexShrink: "0",
    borderWidth: stroke.hairline,
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.3)",
  },
  // relative h-3.5 w-7 shrink-0 border transition-colors border-border bg-surface-raised
  relTightBordered2: {
    position: "relative",
    height: "0.875rem",
    width: "1.75rem",
    flexShrink: "0",
    borderWidth: stroke.hairline,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  // absolute top-0.5 size-2 transition-all left-[calc(100%-0.625rem)] bg-primary
  abs2: {
    position: "absolute",
    left: "calc(100% - 0.625rem)",
    top: space.s0_5,
    width: "0.5rem",
    height: "0.5rem",
    backgroundColor: colors.primary,
    transitionProperty: "all",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  // absolute top-0.5 size-2 transition-all left-0.5 bg-muted-foreground
  abs3: {
    position: "absolute",
    left: space.s0_5,
    top: space.s0_5,
    width: "0.5rem",
    height: "0.5rem",
    backgroundColor: "hsl(var(--muted-foreground))",
    transitionProperty: "all",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
});
