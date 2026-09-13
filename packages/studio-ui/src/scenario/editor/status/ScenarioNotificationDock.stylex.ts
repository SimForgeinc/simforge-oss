import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-none fixed bottom-5 right-5 z-[70] flex w-[min(380px,calc(100vw-2rem))] flex-col-reverse gap-2
  fixedFlexColRev: {
    pointerEvents: "none",
    position: "fixed",
    bottom: "1.25rem",
    right: "1.25rem",
    zIndex: "70",
    display: "flex",
    width: "min(380px, calc(100vw - 2rem))",
    flexDirection: "column-reverse",
    gap: space.md,
  },
  // pointer-events-auto h-auto justify-center border-border/70 bg-background/95 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur-md hover:text-foreground
  midXsMuted: {
    pointerEvents: "auto",
    height: "auto",
    justifyContent: "center",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--background) / 0.95)",
    paddingTop: space.sm,
    paddingBottom: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.text,
    },
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(12px)",
  },
});
