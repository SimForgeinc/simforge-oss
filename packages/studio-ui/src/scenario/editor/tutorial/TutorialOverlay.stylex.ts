import * as stylex from "@stylexjs/stylex";
import { colors, layers, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-none fixed inset-0 z-[80]
  fixedInertInset0: {
    pointerEvents: "none",
    position: "fixed",
    inset: 0,
    zIndex: layers.editorOverlay,
  },
  // tutorial-spotlight-ring absolute border-2 border-primary
  abs: {
    position: "absolute",
    borderWidth: stroke.thick,
    borderColor: colors.primary,
  },
  // pointer-events-auto absolute w-[min(22rem,calc(100vw-2rem))] border border-border bg-popover p-4 text-popover-foreground shadow-2xl
  absBorderedLive: {
    pointerEvents: "auto",
    position: "absolute",
    width: "min(22rem, calc(100vw - 2rem))",
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: colors.popover,
    padding: space.s4,
    color: "hsl(var(--popover-foreground))",
    boxShadow: shadows.elevation2xl,
  },
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
  // text-micro font-bold uppercase tracking-meta-wider text-primary
  capsMicroAccent: {
    color: colors.primary,
  },
  // mt-1 text-sm font-semibold
  smSemibold: {
    marginTop: space.s1,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
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
    backgroundColor: {
      default: null,
      ":hover": colors.hoverWash,
    },
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // mt-2 text-xs leading-5 text-muted-foreground
  xsMuted: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // mt-4 flex items-center gap-2
  flexCenterGap2: {
    marginTop: space.s4,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  // ml-auto h-8
  pushRight: {
    marginLeft: "auto",
  },
  // mt-2 text-micro text-muted-foreground
  microMuted: {
    marginTop: space.s2,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
});
