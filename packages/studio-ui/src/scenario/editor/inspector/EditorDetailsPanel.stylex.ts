import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers, motion } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // editor-actor-details-enter fixed right-[calc(100%-100vw)] top-1/2 z-[82] flex min-w-0 -translate-y-1/2 flex-col overflow-hidden rounded-l-xl border border-r-0 border-white/15 bg-[linear-gradient(155deg,rgba(24,24,22,0.98),rgba(9,9,9,0.98))] text-white shadow-[-12px_20px_60px_rgba(0,0,0,0.62),0_0_0_1px_rgba(232,224,68,0.1)] backdrop-blur-2xl
  fixedFlexCol: {
    position: "fixed",
    right: "calc(100% - 100vw)",
    top: "50%",
    zIndex: "82",
    display: "flex",
    minWidth: "0px",
    transform: "translate(0, -50%)",
    flexDirection: "column",
    overflow: "hidden",
    borderTopLeftRadius: "0",
    borderBottomLeftRadius: "0",
    borderWidth: "1px",
    borderRightWidth: "0px",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundImage: "linear-gradient(155deg, rgba(24, 24, 22, 0.98), rgba(9, 9, 9, 0.98))",
    color: "rgb(255 255 255 / 1)",
    boxShadow: "-12px 20px 60px rgba(0, 0, 0, 0.62), 0 0 0 1px rgba(232, 224, 68, 0.1)",
    backdropFilter: "blur(40px)",
  },
  // absolute bottom-0 left-0 top-0 z-[60] w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[#E8E044]/40 focus-visible:bg-[#E8E044]/60 focus-visible:outline-none
  abs: {
    position: "absolute",
    bottom: space.none,
    left: space.none,
    top: space.none,
    zIndex: layers.editorChrome,
    width: "0.375rem",
    cursor: "col-resize",
    touchAction: "none",
    backgroundColor: {
      default: "transparent",
      ":focus-visible": "rgb(232 224 68 / 0.6)",
      ":hover": "rgb(232 224 68 / 0.4)",
    },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
  },
  // relative shrink-0 overflow-hidden border-b border-white/10 bg-[radial-gradient(circle_at_75%_15%,rgba(232,224,68,0.14),transparent_42%),linear-gradient(145deg,#191a18,#0d0e0d)]
  relTightRuleB: {
    position: "relative",
    flexShrink: "0",
    overflow: "hidden",
    borderBottomWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundImage: "radial-gradient(circle at 75% 15%, rgba(232, 224, 68, 0.14), transparent 42%), linear-gradient(145deg, #191a18, #0d0e0d)",
  },
  // absolute right-2.5 top-2.5 grid size-6 place-items-center rounded-md text-white/45 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  absGridCentered: {
    position: "absolute",
    right: "0.625rem",
    top: "0.625rem",
    display: "grid",
    width: "1.5rem",
    height: "1.5rem",
    placeItems: "center",
    borderRadius: "0",
    color: {
      default: "rgb(255 255 255 / 0.45)",
      ":hover": "rgb(255 255 255 / 1)",
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
      ":focus-visible": "0 0 0 2px rgb(232 224 68 / 1)",
    },
    backgroundColor: {
      default: null,
      ":hover": colors.chip,
    },
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  /*
   * The panel body. `space-y-3` was a `> * + *` rule, which StyleX cannot
   * express, so the stack becomes a flex column with the same 12px gap. Every
   * caller fills this slot with block-level elements that carry no vertical
   * margin, so the boxes and the distances between them are unchanged; and
   * because the automatic minimum size applies to a flex item's main axis
   * only, a column's children still take the scroller's width exactly as
   * blocks did, while their content height keeps them from being squeezed.
   */
  // min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3 text-[11px] [scrollbar-width:thin]
  fillScrollYShrinkable: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    minHeight: "0px",
    minWidth: "0px",
    flex: "1 1 0%",
    overflowY: "auto",
    overflowX: "hidden",
    padding: space.lg,
    fontSize: "11px",
    scrollbarWidth: "thin",
  },
  // absolute inset-0 z-50 grid place-items-center bg-black/70 px-5 text-center backdrop-blur-md
  absGridCentered2: {
    position: "absolute",
    inset: space.none,
    zIndex: "50",
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgb(0 0 0 / 0.7)",
    paddingLeft: "1.25rem",
    paddingRight: "1.25rem",
    textAlign: "center",
    backdropFilter: "blur(12px)",
  },
  // flex flex-col items-center gap-2
  flexColCenter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.md,
  },
  // size-5 fill-[#E8E044] text-[#E8E044]
  size5FillText: {
    width: "1.25rem",
    height: "1.25rem",
    fill: colors.accent,
    color: colors.accent,
  },
  // text-xs leading-snug text-white
  xsWhiteSnug: {
    fontSize: text.sizeXs,
    lineHeight: "1.375",
    color: "rgb(255 255 255 / 1)",
  },
  // text-[10px] text-white/55
  textTextWhite55: {
    fontSize: "10px",
    color: "rgb(255 255 255 / 0.55)",
  },

  // grid place-items-center bg-black/15
  preview: {
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgb(0 0 0 / 0.15)",
  },
  // h-24 px-10 py-3 — the default preview frame.
  previewDefault: {
    height: "6rem",
    paddingLeft: "2.5rem",
    paddingRight: "2.5rem",
    paddingTop: space.lg,
    paddingBottom: space.lg,
  },
});
