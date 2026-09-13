import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex flex-wrap items-center gap-x-1 gap-y-1
  flexCenterWrap: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    MozColumnGap: "0.25rem",
    columnGap: space.xs,
    rowGap: space.xs,
  },
  // flex items-center gap-1
  flexCenterGap1: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
  },
  // w-3 border-t render-hairline
  ruleT: {
    width: "0.75rem",
    borderTopWidth: "1px",
    borderColor: "rgb(255 255 255 / 10%)",
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // font-mono
  mono: {
    fontFamily: text.fontMono,
  },
  // flex shrink-0 items-center justify-between gap-4 render-glass-raised border-t px-6 py-3.5
  flexCenterBetween: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.xl,
    borderTopWidth: "1px",
    paddingLeft: space.xxl,
    paddingRight: space.xxl,
    paddingTop: "0.875rem",
    paddingBottom: "0.875rem",
    backgroundColor: colors.glassRaised,
    borderColor: colors.lineStrong,
  },
  // min-w-0 text-micro text-muted-foreground
  microMutedNarrowable: {
    minWidth: "0px",
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
  // flex shrink-0 items-center gap-2
  flexCenterTight: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: space.md,
  },
  // motionStyles.editorMotion + inline-flex h-9 items-center gap-1.5 border render-hairline render-glass px-3 text-micro font-bold uppercase tracking-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  inlineFlexCenterCaps: {
    display: "inline-flex",
    height: "2.25rem",
    alignItems: "center",
    gap: space.sm,
    borderWidth: "1px",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
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
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // flex w-full min-w-0 items-center gap-2
  flexCenterWide: {
    display: "flex",
    width: "100%",
    minWidth: "0px",
    alignItems: "center",
    gap: space.md,
  },
  // min-w-0 flex-1 truncate text-xs font-semibold text-foreground
  fillXsInk: {
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // text-micro leading-relaxed text-muted-foreground
  microMutedRelaxed: {
    fontSize: text.sizeMicro,
    lineHeight: "1.625",
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + inline-flex items-center gap-1.5 px-2 py-1 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  inlineFlexCenterCaps2: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
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
  // render-step-center flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5
  flexColFill: {
    display: "flex",
    minHeight: "0px",
    flex: "1 1 0%",
    flexDirection: "column",
    overflow: "hidden",
    paddingLeft: space.xxl,
    paddingRight: space.xxl,
    paddingTop: "1.25rem",
    paddingBottom: "1.25rem",
  },
  // motionStyles.editorMotion + inline-flex h-9 items-center gap-1.5 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-not-allowed border render-hairline render-glass text-muted-foreground
  inlineFlexCenterCaps3: {
    display: "inline-flex",
    height: "2.25rem",
    cursor: "not-allowed",
    alignItems: "center",
    gap: space.sm,
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
  // motionStyles.editorMotion + inline-flex h-9 items-center gap-1.5 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring bg-primary text-primary-foreground hover:bg-primary/90
  inlineFlexCenterCaps4: {
    display: "inline-flex",
    height: "2.25rem",
    alignItems: "center",
    gap: space.sm,
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
  // size-4 shrink-0 text-primary
  tightAccent: {
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    color: colors.primary,
  },
  // size-4 shrink-0 text-muted-foreground
  tightMuted: {
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    color: colors.mutedForeground,
  },
  // motionStyles.editorMotion + flex min-w-0 flex-col items-start gap-1 border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  flexColStart: {
    display: "flex",
    minWidth: "0px",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.xs,
    borderWidth: "1px",
    padding: space.lg,
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
  // border-primary bg-primary/10
  borderPrimaryBgPrimary10: {
    borderColor: colors.primary,
    backgroundColor: "hsl(var(--primary) / 0.1)",
  },
  // render-glass hover:border-primary/40
  renderGlassHoverBorderPrimary40: {
    backgroundColor: colors.glass,
    borderColor: {
      default: "rgb(255 255 255 / 10%)",
      ":hover": "hsl(var(--primary) / 0.4)",
    },
  },
  // cursor-not-allowed opacity-50
  cursorNotAllowedOpacity50: {
    cursor: "not-allowed",
    opacity: "0.5",
  },

  // bg-primary text-primary-foreground
  stepActive: {
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
  },
  // text-foreground/80 hover:text-primary
  stepDone: {
    color: {
      default: "hsl(var(--foreground) / 0.8)",
      ":hover": colors.primary,
    },
  },
  // cursor-default text-muted-foreground/50
  stepTodo: {
    cursor: "default",
    color: "hsl(var(--muted-foreground) / 0.5)",
  },
});
