import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring
  wideTall: {
    height: "100%",
    width: "100%",
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
  // pointer-events-none absolute bottom-4 right-4 z-20 max-w-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg
  absXsDanger: {
    pointerEvents: "none",
    position: "absolute",
    bottom: space.xl,
    right: space.xl,
    zIndex: 20,
    maxWidth: "24rem",
    borderWidth: "1px",
    borderColor: "hsl(var(--destructive) / 0.5)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  },
  // pointer-events-none absolute bottom-4 right-4 z-20 text-xs text-white/65
  absXsInert: {
    pointerEvents: "none",
    position: "absolute",
    bottom: space.xl,
    right: space.xl,
    zIndex: 20,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.65)",
  },
  // pointer-events-auto
  live: {
    pointerEvents: "auto",
  },
  // relative min-w-0 flex-1 overflow-hidden pointer-events-none bg-transparent
  // plus the `width/height: 100%` the shell used to impose through
  // `.canvas > *`; that child combinator has no StyleX form, and this root is
  // the child it sized.
  relFillClip: {
    pointerEvents: "none",
    position: "relative",
    width: "100%",
    height: "100%",
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    backgroundColor: "transparent",
  },
  // relative min-w-0 flex-1 overflow-hidden bg-background
  // plus the `width/height: 100%` the shell used to impose through
  // `.canvas > *`.
  relFillClip2: {
    position: "relative",
    width: "100%",
    height: "100%",
    minWidth: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    backgroundColor: colors.bg,
  },
});
