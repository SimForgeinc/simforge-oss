import * as stylex from "@stylexjs/stylex";
import { colors, layers, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

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
      ":focus-visible": shadows.ringInset,
    },
  },
  // pointer-events-none absolute bottom-4 right-4 z-20 max-w-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg
  absXsDanger: {
    pointerEvents: "none",
    position: "absolute",
    bottom: space.s4,
    right: space.s4,
    zIndex: layers.float,
    maxWidth: "24rem",
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--destructive) / 0.5)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
    boxShadow: shadows.elevationLg,
  },
  // pointer-events-none absolute bottom-4 right-4 z-20 text-xs text-white/65
  absXsInert: {
    pointerEvents: "none",
    position: "absolute",
    bottom: space.s4,
    right: space.s4,
    zIndex: layers.float,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
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
