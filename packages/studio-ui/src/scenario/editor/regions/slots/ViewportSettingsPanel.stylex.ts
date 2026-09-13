import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "../../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // absolute right-4 top-4
  abs: {
    position: "absolute",
    right: space.xl,
    top: space.xl,
  },
  // flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1.5
  flexCenterBetween: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    borderBottomWidth: "1px",
    borderColor: colors.border,
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  // font-meta text-micro uppercase tracking-meta-wider text-muted-foreground
  capsMetaMicro: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.mutedForeground,
  },
  // flex items-center gap-0.5
  flexCenterGap05: {
    display: "flex",
    alignItems: "center",
    gap: space.xxs,
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
    padding: space.md,
  },
  // mt-1.5 text-micro leading-snug text-muted-foreground
  microMutedSnug: {
    marginTop: space.sm,
    fontSize: text.sizeMicro,
    lineHeight: "1.375",
    color: colors.mutedForeground,
  },
  // grid grid-cols-2 gap-1
  gridCols2Gap1: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.xs,
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
    gap: space.none,
    overflow: "hidden",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: space.none,
    paddingRight: space.none,
    maxWidth: {
      default: null,
      "@media (min-width: 640px)": "420px",
    },
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
  // mb-1.5 font-meta text-micro uppercase tracking-meta-wider text-muted-foreground/70
  capsMetaMicro2: {
    marginBottom: space.sm,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
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
    gap: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    textAlign: "left",
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
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
  // py-1
  py1: {
    paddingTop: space.xs,
    paddingBottom: space.xs,
  },
  // flex items-baseline justify-between gap-2
  flexBetweenBaseline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.md,
  },
  // text-meta text-muted-foreground
  metaMuted: {
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // font-meta text-micro tabular-nums text-muted-foreground/70
  metaMicroNums: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontVariantNumeric: "tabular-nums",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
  // mt-1 h-1 w-full cursor-pointer appearance-none bg-muted accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  widePointer: {
    marginTop: space.xs,
    height: "0.25rem",
    width: "100%",
    cursor: "pointer",
    WebkitAppearance: "none",
    MozAppearance: "none",
    appearance: "none",
    backgroundColor: colors.muted,
    accentColor: colors.primary,
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
  // h-8 border-border bg-card/90 shadow-sm backdrop-blur gap-2 rounded-none px-3
  glassyGap2: {
    height: "2rem",
    gap: space.md,
    borderRadius: "0",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
  },
  // h-8 border-border bg-card/90 shadow-sm backdrop-blur w-8 shadow-xl
  glassy: {
    height: "2rem",
    width: "2rem",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.9)",
    boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(8px)",
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
    right: space.xl,
    top: space.xl,
    display: "flex",
    maxHeight: "calc(100% - 2rem)",
    width: "300px",
    flexDirection: "column",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.95)",
    boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(8px)",
  },
  // min-h-7 border px-1.5 font-meta text-[9px] font-bold uppercase tracking-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary/15 text-foreground
  capsMetaInk: {
    minHeight: "1.75rem",
    borderWidth: "1px",
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.15)",
    paddingLeft: space.sm,
    paddingRight: space.sm,
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.text,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
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
  // min-h-7 border px-1.5 font-meta text-[9px] font-bold uppercase tracking-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-border bg-surface-raised text-muted-foreground hover:text-foreground
  capsMetaMuted: {
    minHeight: "1.75rem",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    fontFamily: text.fontMeta,
    fontSize: "9px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
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
  // h-7 border font-meta text-micro font-bold uppercase tracking-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-primary bg-primary/15 text-foreground
  capsMetaMicro3: {
    height: "1.75rem",
    borderWidth: "1px",
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.15)",
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.text,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
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
  // h-7 border font-meta text-micro font-bold uppercase tracking-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-border bg-surface-raised text-muted-foreground hover:text-foreground
  capsMetaMicro4: {
    height: "1.75rem",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
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
  // pb-3 mb-3 border-b border-border/60
  ruleB: {
    marginBottom: space.lg,
    borderBottomWidth: "1px",
    borderColor: "hsl(var(--border) / 0.6)",
    paddingBottom: space.lg,
  },
  // pb-3
  pb3: {
    paddingBottom: space.lg,
  },
  // relative h-3.5 w-7 shrink-0 border transition-colors border-primary bg-primary/30
  relTightBordered: {
    position: "relative",
    height: "0.875rem",
    width: "1.75rem",
    flexShrink: "0",
    borderWidth: "1px",
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.3)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  // relative h-3.5 w-7 shrink-0 border transition-colors border-border bg-surface-raised
  relTightBordered2: {
    position: "relative",
    height: "0.875rem",
    width: "1.75rem",
    flexShrink: "0",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  // absolute top-0.5 size-2 transition-all left-[calc(100%-0.625rem)] bg-primary
  abs2: {
    position: "absolute",
    left: "calc(100% - 0.625rem)",
    top: space.xxs,
    width: "0.5rem",
    height: "0.5rem",
    backgroundColor: colors.primary,
    transitionProperty: "all",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  // absolute top-0.5 size-2 transition-all left-0.5 bg-muted-foreground
  abs3: {
    position: "absolute",
    left: space.xxs,
    top: space.xxs,
    width: "0.5rem",
    height: "0.5rem",
    backgroundColor: "hsl(var(--muted-foreground))",
    transitionProperty: "all",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
});
