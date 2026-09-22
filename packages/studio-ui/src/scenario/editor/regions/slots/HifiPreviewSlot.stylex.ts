import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "../../../../stylex/tokens.stylex";

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
    gap: space.s1_5,
  },
  // h-8 rounded-none border border-border/70 bg-card/90 px-2 text-xs text-foreground shadow-sm backdrop-blur
  xsInkBordered: {
    height: "2rem",
    borderRadius: "0",
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.text,
    boxShadow: shadows.elevationSm,
    backdropFilter: motion.blurMd,
  },
  // h-8 gap-2 rounded-none border border-[#7DD3FC]/45 bg-card/90 px-3 text-[#7DD3FC] shadow-sm backdrop-blur hover:border-[#7DD3FC] hover:bg-[#7DD3FC] hover:text-black disabled:border-border disabled:text-muted-foreground
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.s2,
    borderRadius: "0",
    borderWidth: stroke.hairline,
    borderColor: {
      default: "rgb(125 211 252 / 0.45)",
      ":disabled": colors.border,
      ":hover": colors.info,
    },
    backgroundColor: {
      default: "hsl(var(--card) / 0.9)",
      ":hover": "rgb(125 211 252 / 1)",
    },
    paddingLeft: space.s3,
    paddingRight: space.s3,
    color: {
      default: colors.info,
      ":disabled": colors.mutedForeground,
      ":hover": "rgb(0 0 0 / 1)",
    },
    boxShadow: shadows.elevationSm,
    backdropFilter: motion.blurMd,
  },
  // size-4 animate-spin
  spinner: {
    width: "1rem",
    height: "1rem",
    animationName: spin,
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
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
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--card) / 0.95)",
    padding: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
    boxShadow: shadows.elevationLg,
    backdropFilter: motion.blurMd,
  },
  // size-4 animate-spin text-[#7DD3FC]
  spinner2: {
    width: "1rem",
    height: "1rem",
    animationName: spin,
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
    color: colors.info,
  },
  // ml-auto h-6 px-2
  pushRight: {
    marginLeft: "auto",
    height: "1.5rem",
    paddingLeft: space.s2,
    paddingRight: space.s2,
  },
  // pointer-events-auto flex w-full items-start gap-2 border border-red-500/50 bg-card/95 p-3 text-xs text-red-200 shadow-lg backdrop-blur
  flexStartXs: {
    pointerEvents: "auto",
    display: "flex",
    width: "100%",
    alignItems: "flex-start",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: "rgb(239 68 68 / 0.5)",
    backgroundColor: "hsl(var(--card) / 0.95)",
    padding: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: "rgb(254 202 202 / 1)",
    boxShadow: shadows.elevationLg,
    backdropFilter: motion.blurMd,
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
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--card) / 0.95)",
    boxShadow: shadows.elevationXl,
    backdropFilter: motion.blurMd,
  },
  // flex items-center justify-between border-b border-border/60 px-2 py-1
  flexCenterBetween: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: stroke.hairline,
    borderColor: "hsl(var(--border) / 0.6)",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
  },
  // text-[11px] font-medium uppercase tracking-wide text-[#7DD3FC]
  capsMedium: {
    fontSize: "11px",
    fontWeight: text.weightMedium,
    textTransform: "uppercase",
    letterSpacing: text.trackingWide,
    color: colors.info,
  },
  // h-6 px-1.5
  h6Px15: {
    height: "1.5rem",
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
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
    gap: space.s2,
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
    gap: space.s2,
  },
  // flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border/60 px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground
  flexCenterWrap: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    MozColumnGap: "0.75rem",
    columnGap: space.s3,
    rowGap: space.s0_5,
    borderTopWidth: stroke.hairline,
    borderColor: "hsl(var(--border) / 0.6)",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontFamily: text.fontMono,
    fontSize: "10px",
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
});
