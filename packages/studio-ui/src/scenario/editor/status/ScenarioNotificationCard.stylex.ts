import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "../../../stylex/tokens.stylex";

// `animate-spin`.
const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

export const styles = stylex.create({
  // flex items-start gap-2
  flexStartGap2: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.md,
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // flex items-center gap-1.5
  flexCenterGap15: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
  },
  // text-micro font-bold uppercase tracking-meta opacity-70
  capsMicroBold: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    opacity: "0.7",
  },
  // border border-border/70 bg-muted/40 px-1 text-micro font-bold tabular-nums
  microBoldBordered: {
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--muted) / 0.4)",
    paddingLeft: space.xs,
    paddingRight: space.xs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    fontVariantNumeric: "tabular-nums",
  },
  // ml-auto text-meta font-medium tabular-nums opacity-80
  metaMediumPushRight: {
    marginLeft: "auto",
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    fontVariantNumeric: "tabular-nums",
    opacity: "0.8",
  },
  // mt-0.5 text-sm font-medium leading-snug
  smMediumSnug: {
    marginTop: space.xxs,
    fontSize: text.sizeSm,
    lineHeight: "1.375",
    fontWeight: text.weightMedium,
  },
  // mt-0.5 text-xs leading-snug opacity-70
  xsSnug: {
    marginTop: space.xxs,
    fontSize: text.sizeXs,
    lineHeight: "1.375",
    opacity: "0.7",
  },
  // mt-2 h-7 px-2.5 text-xs
  xs: {
    marginTop: space.md,
    height: "1.75rem",
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // absolute inset-x-0 bottom-0 h-0.5 bg-muted
  abs: {
    position: "absolute",
    left: space.none,
    right: space.none,
    bottom: space.none,
    height: "0.125rem",
    backgroundColor: colors.muted,
  },
  // block h-full bg-primary transition-[width] duration-300 motion-reduce:transition-none
  blockTall: {
    display: "block",
    height: "100%",
    backgroundColor: colors.primary,
    transitionProperty: {
      default: "width",
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "300ms",
    animationDuration: "300ms",
  },
  /*
   * The card's two icon controls. `-mt-1` pulls them level with the heading's
   * cap height rather than its line box; `focus-visible:ring-offset-1
   * ring-offset-background` is the two-shadow ring, drawn from the card's own
   * backdrop outwards so the ring reads against the translucent chrome.
   */
  // -mt-1 inline-flex size-7 shrink-0 items-center justify-center border border-border/70 bg-muted/40 text-current hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background
  iconButton: {
    marginTop: "-0.25rem",
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: {
      default: "hsl(var(--muted) / 0.4)",
      ":hover": "hsl(var(--accent))",
    },
    color: "currentColor",
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
      ":focus-visible":
        "0 0 0 1px hsl(var(--background)), 0 0 0 3px hsl(var(--ring))",
    },
  },
  // -mr-1
  iconButtonEdge: {
    marginRight: "-0.25rem",
  },

  // pointer-events-auto border px-3 py-2 shadow-lg backdrop-blur-md
  card: {
    pointerEvents: "auto",
    borderWidth: "1px",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(12px)",
  },
  // border-destructive/50 bg-destructive/20 text-foreground
  cardError: {
    borderColor: "hsl(var(--destructive) / 0.5)",
    backgroundColor: "hsl(var(--destructive) / 0.2)",
    color: colors.text,
  },
  // border-amber-400/40 bg-amber-500/15 text-foreground
  cardWarning: {
    borderColor: "rgb(251 191 36 / 0.4)",
    backgroundColor: "rgb(245 158 11 / 0.15)",
    color: colors.text,
  },
  // border-emerald-400/40 bg-emerald-500/15 text-foreground
  cardSuccess: {
    borderColor: "rgb(52 211 153 / 0.4)",
    backgroundColor: "rgb(16 185 129 / 0.15)",
    color: colors.text,
  },
  // border-border/70 bg-background/95 text-foreground
  cardNeutral: {
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--background) / 0.95)",
    color: colors.text,
  },
  // relative overflow-hidden pb-2.5 — the progress rail needs a containing
  // block and the extra bottom room it sits in.
  cardWithProgress: {
    position: "relative",
    overflow: "hidden",
    paddingBottom: "0.625rem",
  },
  // mt-0.5 size-4 shrink-0
  icon: {
    marginTop: "0.125rem",
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
  },
  // animate-spin text-primary — Tailwind's `animate-spin` carried no
  // reduced-motion guard here and neither does this, so the spinner behaves
  // exactly as it did.
  iconSpinning: {
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    color: colors.primary,
  },
});
