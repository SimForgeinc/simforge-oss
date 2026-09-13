import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-none fixed inset-0 z-[80]
  fixedInertInset0: {
    pointerEvents: "none",
    position: "fixed",
    inset: space.none,
    zIndex: layers.editorOverlay,
  },
  // tutorial-spotlight-ring absolute border-2 border-primary
  abs: {
    position: "absolute",
    borderWidth: "2px",
    borderColor: colors.primary,
  },
  // pointer-events-auto absolute w-[min(22rem,calc(100vw-2rem))] border border-border bg-popover p-4 text-popover-foreground shadow-2xl
  absBorderedLive: {
    pointerEvents: "auto",
    position: "absolute",
    width: "min(22rem, calc(100vw - 2rem))",
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: colors.popover,
    padding: space.xl,
    color: "hsl(var(--popover-foreground))",
    boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
  },
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
  // text-micro font-bold uppercase tracking-meta-wider text-primary
  capsMicroAccent: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWider,
    color: colors.primary,
  },
  // mt-1 text-sm font-semibold
  smSemibold: {
    marginTop: space.xs,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // motionStyles.editorMotion + -mr-1 -mt-1 inline-flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover
  inlineFlexCenterMid: {
    marginRight: "-0.25rem",
    marginTop: "-0.25rem",
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
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
      ":focus-visible": "0 0 0 1px hsl(var(--popover)), 0 0 0 3px hsl(var(--ring))",
    },
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--accent))",
    },
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // mt-2 text-xs leading-5 text-muted-foreground
  xsMuted: {
    marginTop: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // mt-4 flex items-center gap-2
  flexCenterGap2: {
    marginTop: space.xl,
    display: "flex",
    alignItems: "center",
    gap: space.md,
  },
  // h-8
  h8: {
    height: "2rem",
  },
  // ml-auto h-8
  pushRight: {
    marginLeft: "auto",
    height: "2rem",
  },
  // mt-2 text-micro text-muted-foreground
  microMuted: {
    marginTop: space.md,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    color: colors.mutedForeground,
  },
});
