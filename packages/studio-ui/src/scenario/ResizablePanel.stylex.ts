import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, space } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  panel: { position: "relative", display: "flex", height: "100%", minHeight: 0, minWidth: 0, flexShrink: 0, flexDirection: "column" },
  solid: { borderRight: `1px solid ${colors.border}`, backgroundColor: colors.bg },
  gradient: {
    isolation: "isolate", overflow: "visible", backgroundColor: "transparent",
    "::before": {
      content: '""', pointerEvents: "none", position: "absolute", top: 0, bottom: 0, left: "-25vw", width: "100vw", zIndex: -1,
      backgroundImage: "linear-gradient(75deg,rgba(5,6,8,0.76) 0%,rgba(5,6,8,0.64) 34%,rgba(5,6,8,0.32) 56%,rgba(5,6,8,0.1) 70%,transparent 82%)",
      backdropFilter: "blur(64px)",
      maskImage: "linear-gradient(75deg,#000 0%,#000 45%,rgba(0,0,0,0.82) 60%,rgba(0,0,0,0.3) 76%,transparent 90%)",
    },
  },
  collapsed: { pointerEvents: "none", transform: "translateX(-1rem)", opacity: 0 },
  singlePane: { width: "100%", flex: 1, marginLeft: 0 },
  // absolute -right-[3px] bottom-0 top-0 z-10 w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none
  scenarioPanelResizeHandle: {
    position: "absolute",
    right: "-3px",
    bottom: "0",
    top: "0",
    zIndex: layers.raised,
    width: space.s1_5,
    cursor: "col-resize",
    touchAction: "none",
    backgroundColor: { default: "transparent", ":hover": "hsl(var(--primary) / 0.4)", ":focus-visible": "hsl(var(--primary) / 0.6)" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: motion.durStandard,
    transitionTimingFunction: motion.easeStandard,
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
});
