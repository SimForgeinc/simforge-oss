import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers } from "../../../../stylex/tokens.stylex";

/** `animate-spin`. One revolution per second, as the utility was. */
const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

export const styles = stylex.create({
  // pointer-events-auto flex items-center gap-1.5
  flexCenterLive: {
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    gap: space.sm,
  },
  // h-8 rounded-none border border-border/70 bg-card/90 px-2 text-xs text-foreground shadow-sm backdrop-blur
  xsInkBordered: {
    height: "2rem",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.md,
    paddingRight: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.text,
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
  },
  // h-8 gap-2 rounded-none border border-[#7DD3FC]/45 bg-card/90 px-3 text-[#7DD3FC] shadow-sm backdrop-blur hover:border-[#7DD3FC] hover:bg-[#7DD3FC] hover:text-black disabled:border-border disabled:text-muted-foreground
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.md,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: {
      default: "rgb(125 211 252 / 0.45)",
      ":disabled": colors.border,
      ":hover": "rgb(125 211 252 / 1)",
    },
    backgroundColor: {
      default: "hsl(var(--card) / 0.9)",
      ":hover": "rgb(125 211 252 / 1)",
    },
    paddingLeft: space.lg,
    paddingRight: space.lg,
    color: {
      default: "rgb(125 211 252 / 1)",
      ":disabled": colors.mutedForeground,
      ":hover": "rgb(0 0 0 / 1)",
    },
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
  },
  // size-4 animate-spin
  spinner: {
    width: "1rem",
    height: "1rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // pointer-events-auto flex w-full items-center gap-2 border border-border/70 bg-card/95 p-3 text-xs text-muted-foreground shadow-lg backdrop-blur
  flexCenterXs: {
    pointerEvents: "auto",
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.md,
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--card) / 0.95)",
    padding: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(8px)",
  },
  // size-4 animate-spin text-[#7DD3FC]
  spinner2: {
    width: "1rem",
    height: "1rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    color: "rgb(125 211 252 / 1)",
  },
  // ml-auto h-6 px-2
  pushRight: {
    marginLeft: "auto",
    height: "1.5rem",
    paddingLeft: space.md,
    paddingRight: space.md,
  },
  // pointer-events-auto flex w-full items-start gap-2 border border-red-500/50 bg-card/95 p-3 text-xs text-red-200 shadow-lg backdrop-blur
  flexStartXs: {
    pointerEvents: "auto",
    display: "flex",
    width: "100%",
    alignItems: "flex-start",
    gap: space.md,
    borderWidth: "1px",
    borderColor: "rgb(239 68 68 / 0.5)",
    backgroundColor: "hsl(var(--card) / 0.95)",
    padding: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(254 202 202 / 1)",
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(8px)",
  },
  // min-w-0
  narrowable: {
    minWidth: "0px",
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // pointer-events-auto w-full border border-border/70 bg-card/95 shadow-xl backdrop-blur
  borderedLiveWide: {
    pointerEvents: "auto",
    width: "100%",
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--card) / 0.95)",
    boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(8px)",
  },
  // flex items-center justify-between border-b border-border/60 px-2 py-1
  flexCenterBetween: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: "1px",
    borderColor: "hsl(var(--border) / 0.6)",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
  },
  // text-[11px] font-medium uppercase tracking-wide text-[#7DD3FC]
  capsMedium: {
    fontSize: "11px",
    fontWeight: text.weightMedium,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: "rgb(125 211 252 / 1)",
  },
  // h-6 px-1.5
  h6Px15: {
    height: "1.5rem",
    paddingLeft: space.sm,
    paddingRight: space.sm,
  },
  // block w-full
  blockWide: {
    display: "block",
    width: "100%",
  },
  // pointer-events-none fixed right-5 top-16 z-[60] flex flex-col items-end gap-2 w-[min(720px,calc(50vw-1.5rem))]
  fixedFlexCol: {
    pointerEvents: "none",
    position: "fixed",
    right: "1.25rem",
    top: "4rem",
    zIndex: layers.editorChrome,
    display: "flex",
    width: "min(720px, calc(50vw - 1.5rem))",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space.md,
  },
  // pointer-events-none fixed right-5 top-16 z-[60] flex flex-col items-end gap-2 w-[min(460px,calc(100vw-2rem))]
  fixedFlexCol2: {
    pointerEvents: "none",
    position: "fixed",
    right: "1.25rem",
    top: "4rem",
    zIndex: layers.editorChrome,
    display: "flex",
    width: "min(460px, calc(100vw - 2rem))",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space.md,
  },
  // flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border/60 px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground
  flexCenterWrap: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    MozColumnGap: "0.75rem",
    columnGap: space.lg,
    rowGap: space.xxs,
    borderTopWidth: "1px",
    borderColor: "hsl(var(--border) / 0.6)",
    paddingLeft: space.md,
    paddingRight: space.md,
    paddingTop: space.xs,
    paddingBottom: space.xs,
    fontFamily: text.fontMono,
    fontSize: "10px",
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
});
