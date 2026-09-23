import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex items-start gap-2
  flexStartGap2: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
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
    gap: space.s1_5,
  },
  // text-micro font-bold uppercase tracking-meta opacity-70
  capsMicroBold: {
    opacity: "0.7",
  },
  // border border-border/70 bg-muted/40 px-1 text-micro font-bold tabular-nums
  microBoldBordered: {
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: colors.fillSubtle,
    paddingLeft: space.s1,
    paddingRight: space.s1,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    fontWeight: text.weightBold,
    fontVariantNumeric: "tabular-nums",
  },
  // ml-auto text-meta font-medium tabular-nums opacity-80
  metaMediumPushRight: {
    marginLeft: "auto",
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    fontVariantNumeric: "tabular-nums",
    opacity: "0.8",
  },
  // mt-0.5 text-sm font-medium leading-snug
  smMediumSnug: {
    marginTop: space.s0_5,
    fontSize: text.sizeSm,
    lineHeight: text.lineSnug,
    fontWeight: text.weightMedium,
  },
  // mt-0.5 text-xs leading-snug opacity-70
  xsSnug: {
    marginTop: space.s0_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineSnug,
    opacity: "0.7",
  },
  // mt-2 h-7 px-2.5 text-xs
  xs: {
    marginTop: space.s2,
    paddingLeft: space.s2_5,
    paddingRight: space.s2_5,
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // absolute inset-x-0 bottom-0 h-0.5 bg-muted
  abs: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
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
      [layout.reducedMotion]: "none",
    },
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durSlow,
    animationDuration: motion.durSlow,
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
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: {
      default: colors.fillSubtle,
      ":hover": colors.hoverWash,
    },
    color: "currentColor",
  },
  // -mr-1
  iconButtonEdge: {
    marginRight: "-0.25rem",
  },

  // pointer-events-auto border px-3 py-2 shadow-lg backdrop-blur-md
  card: {
    pointerEvents: "auto",
    borderWidth: stroke.hairline,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    boxShadow: shadows.elevationLg,
    backdropFilter: motion.blurGlass,
  },
  // border-destructive/50 bg-destructive/20 text-foreground
  cardError: {
    borderColor: colors.critical,
    backgroundColor: colors.criticalWash,
    color: colors.text,
  },
  // border-amber-400/40 bg-amber-500/15 text-foreground
  cardWarning: {
    borderColor: colors.warning,
    backgroundColor: colors.warningWash,
    color: colors.text,
  },
  // border-emerald-400/40 bg-emerald-500/15 text-foreground
  cardSuccess: {
    borderColor: colors.positive,
    backgroundColor: colors.positiveWash,
    color: colors.text,
  },
  // border-border/70 bg-background/95 text-foreground
  cardNeutral: {
    borderColor: colors.hairline,
    backgroundColor: "hsl(var(--background) / 0.95)",
    color: colors.text,
  },
  // relative overflow-hidden pb-2.5 — the progress rail needs a containing
  // block and the extra bottom room it sits in.
  cardWithProgress: {
    position: "relative",
    overflow: "hidden",
    paddingBottom: space.s2_5,
  },
  // mt-0.5 size-4 shrink-0
  icon: {
    marginTop: space.s0_5,
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
  },
  // animate-spin text-primary — Tailwind's `animate-spin` carried no
  // reduced-motion guard here and neither does this, so the spinner behaves
  // exactly as it did.
  iconSpinning: {
    color: colors.primary,
  },
});
