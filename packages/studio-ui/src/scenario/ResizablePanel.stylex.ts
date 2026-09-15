import * as stylex from "@stylexjs/stylex";
import { layers, space } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  // absolute -right-[3px] bottom-0 top-0 z-10 w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none
  scenarioPanelResizeHandle: {
    position: "absolute",
    right: "-3px",
    bottom: "0",
    top: "0",
    zIndex: layers.raised,
    width: space.sm,
    cursor: "col-resize",
    touchAction: "none",
    backgroundColor: { default: "transparent", ":hover": "hsl(var(--primary) / 0.4)", ":focus-visible": "hsl(var(--primary) / 0.6)" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
});
