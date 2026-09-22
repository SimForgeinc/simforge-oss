import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers, motion } from "../../../stylex/tokens.stylex";

// `animate-pulse`. Guarded for `prefers-reduced-motion` because the callsite
// paired the utility with `motion-reduce:animate-none`.
const pulse = stylex.keyframes({
  "50%": { opacity: 0.5 },
});

/**
 * State the rail's interactive ancestors publish for their inert children.
 *
 * Each of these was a `group-*` variant on a child whose own StyleX rule
 * declares the same property. StyleX guards every atomic rule with repeated
 * `:not(#\#)`, so a descendant selector can never outrank it and the variant
 * would sit in the class list doing nothing. The ancestor publishes the value
 * instead; the child keeps its own transition, so the change still animates.
 */
export const hovered = stylex.defineVars({
  /** Split-resize hairline: `group-hover`/`group-focus-visible` tint. */
  splitLineColor: "rgb(255 255 255 / 0.25)",
  /** Playhead knob: `group-hover:scale-125`. */
  playheadScale: "1",
  /** Interaction-clip resize handles: `group-hover/clip:before:opacity-100`. */
  clipHandleOpacity: "0",
});

export const styles = stylex.create({
  // absolute left-1/2 top-0 z-40 flex h-3 w-24 -translate-x-1/2 cursor-ns-resize touch-none items-start justify-center pt-1
  absFlexMid: {
    position: "absolute",
    left: "50%",
    top: 0,
    zIndex: "40",
    display: "flex",
    height: "0.75rem",
    width: "6rem",
    transform: "translate(-50%, 0)",
    cursor: "ns-resize",
    touchAction: "none",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: space.s1,
  },
  // h-1 w-10 rounded-full bg-white/35 transition-colors hover:bg-[#E8E044]/70
  round: {
    height: "0.25rem",
    width: "2.5rem",
    borderRadius: "0",
    backgroundColor: {
      default: "rgb(255 255 255 / 0.35)",
      ":hover": "rgb(232 224 68 / 0.7)",
    },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  // absolute inset-y-0 z-40 -ml-1.5 w-3 cursor-col-resize touch-none
  // The `group` marker is gone: the hairline below reads `hovered` instead.
  abs: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: "40",
    marginLeft: "-0.375rem",
    width: "0.75rem",
    cursor: "col-resize",
    touchAction: "none",
    [hovered.splitLineColor]: "rgb(255 255 255 / 0.25)",
    ":hover": {
      [hovered.splitLineColor]: "rgb(232 224 68 / 0.8)",
    },
    ":focus-visible": {
      [hovered.splitLineColor]: colors.accent,
    },
  },
  // pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/25 transition-colors group-hover:bg-[#E8E044]/80 group-focus-visible:bg-[#E8E044]
  absInert: {
    pointerEvents: "none",
    position: "absolute",
    top: 0,
    bottom: 0,
    left: "50%",
    width: "1px",
    transform: "translate(-50%, 0)",
    backgroundColor: hovered.splitLineColor,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  // relative z-10 grid h-12 shrink-0 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] overflow-hidden rounded-t-[24px] border-b border-white/10 bg-gradient-to-r from-[#E8E044]/[0.07] via-white/[0.025] to-transparent
  relGridTight: {
    position: "relative",
    zIndex: layers.raised,
    display: "grid",
    height: "3rem",
    flexShrink: "0",
    gridTemplateColumns: "var(--timeline-identity-width) minmax(0, 1fr)",
    overflow: "hidden",
    borderTopLeftRadius: "24px",
    borderTopRightRadius: "24px",
    borderBottomWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundImage: "linear-gradient(to right, rgb(232 224 68 / 0.07), rgb(255 255 255 / 0.025), transparent)",
  },
  // flex min-w-0 items-center justify-center overflow-hidden border-r border-white/10
  flexCenterMid: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
  },
  // flex w-max flex-col items-center justify-center gap-0.5 px-2
  flexColCenter: {
    display: "flex",
    width: "max-content",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s0_5,
    paddingLeft: space.s2,
    paddingRight: space.s2,
  },
  // whitespace-nowrap text-center text-[8px] font-bold uppercase tracking-[0.12em] text-[#E8E044]
  capsBoldNowrap: {
    whiteSpace: "nowrap",
    textAlign: "center",
    fontSize: "8px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaTight,
    color: colors.accent,
  },
  // relative min-w-0 self-stretch cursor-pointer
  relNarrowableSelfStretch: {
    position: "relative",
    minWidth: "0px",
    cursor: "pointer",
    alignSelf: "stretch",
  },
  // mb-0 h-full border-b-0 bg-black/20
  tall: {
    marginBottom: 0,
    height: "100%",
    borderBottomWidth: "0px",
    backgroundColor: "rgb(0 0 0 / 0.2)",
  },
  // pointer-events-none absolute inset-y-0 z-20 w-px bg-[#E8E044] shadow-[0_0_10px_rgba(232,224,68,0.65)]
  absInertRaised: {
    pointerEvents: "none",
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: "20",
    width: "1px",
    backgroundColor: colors.accent,
    boxShadow: "0 0 10px rgba(232, 224, 68, 0.65)",
  },
  // pointer-events-auto absolute -left-2 inset-y-0 w-4 cursor-ew-resize touch-none bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  // The `group` marker is gone: the knob below reads `hovered.playheadScale`.
  absLivePad0: {
    pointerEvents: "auto",
    position: "absolute",
    top: 0,
    bottom: 0,
    left: "-0.5rem",
    width: "1rem",
    cursor: "ew-resize",
    touchAction: "none",
    backgroundColor: "transparent",
    padding: 0,
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
    [hovered.playheadScale]: "1",
    ":hover": {
      [hovered.playheadScale]: "1.25",
    },
  },
  // absolute left-1/2 top-0 size-3 -translate-x-1/2 rounded-full bg-[#E8E044] shadow-[0_0_10px_rgba(232,224,68,0.55)] transition-transform group-hover:scale-125
  absRound: {
    position: "absolute",
    left: "50%",
    top: 0,
    width: "0.75rem",
    height: "0.75rem",
    transform: `translate(-50%, 0) scale(${hovered.playheadScale})`,
    borderRadius: "0",
    backgroundColor: colors.accent,
    boxShadow: "0 0 10px rgba(232, 224, 68, 0.55)",
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  // relative z-10 min-h-0 flex-1 overflow-hidden bg-black/10
  relFillClip: {
    position: "relative",
    zIndex: layers.raised,
    minHeight: "0px",
    flex: "1 1 0%",
    overflow: "hidden",
    backgroundColor: "rgb(0 0 0 / 0.1)",
  },
  // absolute inset-0 overflow-y-auto
  absScrollYInset0: {
    position: "absolute",
    inset: 0,
    overflowY: "auto",
  },
  // min-h-full pb-12
  minHFullPb12: {
    minHeight: "100%",
    paddingBottom: "3rem",
  },
  // m-3 grid h-24 place-items-center border border-dashed border-white/15 px-4 text-center text-xs text-white/35
  gridCenteredXs: {
    margin: space.s3,
    display: "grid",
    height: "6rem",
    placeItems: "center",
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: "rgb(255 255 255 / 0.15)",
    paddingLeft: space.s4,
    paddingRight: space.s4,
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.inkFaint,
  },
  // grid h-10 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] border-b border-white/10 bg-black/20
  gridRuleB: {
    display: "grid",
    height: "2.5rem",
    gridTemplateColumns: "var(--timeline-identity-width) minmax(0, 1fr)",
    borderBottomWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(0 0 0 / 0.2)",
  },
  // flex min-w-0 items-stretch overflow-hidden border-r border-white/10 bg-[#E8E044]/[0.06]
  flexStretchRuleR: {
    display: "flex",
    minWidth: "0px",
    alignItems: "stretch",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(232 224 68 / 0.06)",
  },
  // flex w-max items-stretch self-stretch
  flexStretchSelfStretch: {
    display: "flex",
    width: "max-content",
    alignItems: "stretch",
    alignSelf: "stretch",
  },
  // motionStyles.editorMotion + flex items-center gap-1.5 px-2 text-left text-[9px] text-[#E8E044] hover:bg-[#E8E044]/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#E8E044]
  flexCenterGap15: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    textAlign: "left",
    fontSize: "9px",
    color: colors.accent,
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
      ":focus-visible": "inset 0 0 0 1px rgb(232 224 68 / 1)",
    },
    backgroundColor: {
      default: null,
      ":hover": "rgb(232 224 68 / 0.1)",
    },
  },
  // size-3 shrink-0
  tight: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: "0",
  },
  // whitespace-nowrap
  nowrap: {
    whiteSpace: "nowrap",
  },
  // flex items-center gap-1.5 px-2 text-[9px] text-[#E8E044]/80
  flexCenterGap152: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: "9px",
    color: "rgb(232 224 68 / 0.8)",
  },
  // motionStyles.editorMotion + grid w-6 shrink-0 place-items-center border-l border-white/10 text-white/35 hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-red-300
  gridCenteredTight: {
    display: "grid",
    width: "1.5rem",
    flexShrink: "0",
    placeItems: "center",
    borderLeftWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    color: {
      default: colors.inkFaint,
      ":hover": "rgb(252 165 165 / 1)",
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
      ":focus-visible": "inset 0 0 0 1px rgb(252 165 165 / 1)",
    },
    backgroundColor: {
      default: null,
      ":hover": "rgb(239 68 68 / 0.15)",
    },
  },
  // size-3
  size3: {
    width: "0.75rem",
    height: "0.75rem",
  },
  // relative my-2 cursor-pointer overflow-hidden bg-white/[0.025]
  relClipPointer: {
    position: "relative",
    marginTop: space.s2,
    marginBottom: space.s2,
    cursor: "pointer",
    overflow: "hidden",
    backgroundColor: "rgb(255 255 255 / 0.025)",
  },
  // grid border-b border-white/10
  gridRuleB2: {
    display: "grid",
    borderBottomWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
  },
  // relative z-10 flex min-w-0 items-start overflow-hidden border-r border-white/10 bg-[#E8E044]/[0.04] text-[#E8E044]/80
  relFlexStart: {
    position: "relative",
    zIndex: layers.raised,
    display: "flex",
    minWidth: "0px",
    alignItems: "flex-start",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(232 224 68 / 0.04)",
    color: "rgb(232 224 68 / 0.8)",
  },
  // flex w-max items-start gap-1.5 px-2 py-2
  flexStartGap15: {
    display: "flex",
    width: "max-content",
    alignItems: "flex-start",
    gap: space.s1_5,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s2,
    paddingBottom: space.s2,
  },
  // mt-0.5 size-3 shrink-0
  tight2: {
    marginTop: space.s0_5,
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: "0",
  },
  // whitespace-nowrap text-[9px] font-medium
  mediumNowrap: {
    whiteSpace: "nowrap",
    fontSize: "9px",
    fontWeight: text.weightMedium,
  },
  // flex items-center gap-1.5 rounded-sm text-left enabled:cursor-pointer enabled:hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#E8E044]
  flexCenterGap153: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: "0",
    textAlign: "left",
    cursor: {
      default: null,
      ":enabled": "pointer",
    },
    color: {
      default: null,
      ":enabled:hover": "rgb(255 255 255 / 1)",
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
      ":focus-visible": "0 0 0 1px rgb(232 224 68 / 1)",
    },
  },
  // inline-flex size-4 shrink-0 items-center justify-center bg-transparent p-0 text-white/35 transition-colors hover:bg-transparent hover:text-red-300 focus-visible:bg-transparent focus-visible:text-red-300 focus-visible:outline-none
  inlineFlexCenterMid: {
    display: "inline-flex",
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: {
      default: "transparent",
      ":focus-visible": "transparent",
      ":hover": "transparent",
    },
    padding: 0,
    color: {
      default: colors.inkFaint,
      ":focus-visible": "rgb(252 165 165 / 1)",
      ":hover": "rgb(252 165 165 / 1)",
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
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // flex cursor-pointer items-center px-2 text-[9px] uppercase tracking-[0.12em] text-white/25
  flexCenterCaps: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaTight,
    color: "rgb(255 255 255 / 0.25)",
  },
  // relative cursor-pointer bg-black/15
  relPointer: {
    position: "relative",
    cursor: "pointer",
    backgroundColor: "rgb(0 0 0 / 0.15)",
  },
  // absolute inset-0 grid place-items-center text-[8px] text-white/20
  absGridCentered: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    fontSize: "8px",
    color: "rgb(255 255 255 / 0.2)",
  },
  // grid h-10 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] border-b border-white/10 bg-[#E8E044]/[0.025]
  gridRuleB3: {
    display: "grid",
    height: "2.5rem",
    gridTemplateColumns: "var(--timeline-identity-width) minmax(0, 1fr)",
    borderBottomWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(232 224 68 / 0.025)",
  },
  // flex min-w-0 items-center overflow-hidden border-r border-white/10 text-[#E8E044]/80
  flexCenterRuleR: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    color: "rgb(232 224 68 / 0.8)",
  },
  // flex w-max items-center gap-1.5 px-2
  flexCenterGap154: {
    display: "flex",
    width: "max-content",
    alignItems: "center",
    gap: space.s1_5,
    paddingLeft: space.s2,
    paddingRight: space.s2,
  },
  // whitespace-nowrap text-[8px] font-semibold uppercase tracking-[0.08em]
  capsSemiboldNowrap: {
    whiteSpace: "nowrap",
    fontSize: "8px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  // block truncate
  blockTruncate: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // flex flex-col items-center gap-1 text-center
  flexColCenter2: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s1,
    textAlign: "center",
  },
  // size-8 text-[#E8E044]
  size8Text: {
    width: "2rem",
    height: "2rem",
    color: colors.accent,
  },
  // text-[10px] font-semibold text-white
  whiteSemibold: {
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    color: "rgb(255 255 255 / 1)",
  },
  // text-[8px] text-white/40
  textTextWhite40: {
    fontSize: "8px",
    color: "rgb(255 255 255 / 0.4)",
  },
  // grid grid-cols-2 gap-2
  gridCols2Gap2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s2,
  },
  // min-w-0 text-[8px] uppercase tracking-[0.1em] text-white/45
  capsNarrowable: {
    minWidth: "0px",
    fontSize: "8px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-1 h-8 w-full min-w-0 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] normal-case text-white outline-none focus:border-[#E8E044]/60
  whiteBorderedWide: {
    marginTop: space.s1,
    height: "2rem",
    width: "100%",
    minWidth: "0px",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: {
      default: "rgb(255 255 255 / 0.1)",
      ":focus": "rgb(232 224 68 / 0.6)",
    },
    backgroundColor: colors.fillSubtle,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: "10px",
    textTransform: "none",
    color: "rgb(255 255 255 / 1)",
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // block text-[8px] uppercase tracking-[0.1em] text-white/45
  blockCaps: {
    display: "block",
    fontSize: "8px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-1 min-h-24 w-full resize-y rounded-md border border-white/10 bg-white/[0.04] p-2 text-[10px] normal-case leading-relaxed text-white outline-none focus:border-[#E8E044]/60
  whiteBorderedWide2: {
    marginTop: space.s1,
    minHeight: "6rem",
    width: "100%",
    resize: "vertical",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: {
      default: "rgb(255 255 255 / 0.1)",
      ":focus": "rgb(232 224 68 / 0.6)",
    },
    backgroundColor: colors.fillSubtle,
    padding: space.s2,
    fontSize: "10px",
    textTransform: "none",
    lineHeight: "1.625",
    color: "rgb(255 255 255 / 1)",
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // grid grid-cols-1 gap-1.5 border-t border-white/10 pt-3
  gridRuleTCols1: {
    display: "grid",
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    gap: space.s1_5,
    borderTopWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.s3,
  },
  // h-8 rounded-md bg-[#E8E044] px-3 text-[10px] font-semibold text-black disabled:opacity-40
  semibold: {
    height: "2rem",
    borderRadius: "0",
    backgroundColor: colors.accent,
    paddingLeft: space.s3,
    paddingRight: space.s3,
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    color: "rgb(0 0 0 / 1)",
    opacity: {
      default: null,
      ":disabled": "0.4",
    },
  },
  // flex h-8 items-center justify-center gap-1.5 rounded-md border border-red-300/20 text-[9px] text-red-200 hover:bg-red-300/10
  flexCenterMid2: {
    display: "flex",
    height: "2rem",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1_5,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(252 165 165 / 0.2)",
    fontSize: "9px",
    color: "rgb(254 202 202 / 1)",
    backgroundColor: {
      default: null,
      ":hover": "rgb(252 165 165 / 0.1)",
    },
  },
  // relative cursor-pointer overflow-hidden bg-black/15
  relClipPointer2: {
    position: "relative",
    cursor: "pointer",
    overflow: "hidden",
    backgroundColor: "rgb(0 0 0 / 0.15)",
  },
  // contents
  contents: {
    display: "contents",
  },
  // absolute inset-x-0 top-1/2 h-px bg-white/[0.06]
  abs2: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    height: "1px",
    backgroundColor: "rgb(255 255 255 / 0.06)",
  },
  // pointer-events-none absolute inset-y-0 z-[5] w-px -translate-x-1/2 bg-amber-300/80 shadow-[0_0_6px_rgba(252,211,77,0.45)] before:absolute before:left-1/2 before:top-0 before:size-1 before:-translate-x-1/2 before:rounded-full before:bg-amber-200
  absInert2: {
    pointerEvents: "none",
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: "5",
    width: "1px",
    transform: "translate(-50%, 0)",
    backgroundColor: "rgb(252 211 77 / 0.8)",
    boxShadow: "0 0 6px rgba(252, 211, 77, 0.45)",
    "::before": {
      content: "''",
      position: "absolute",
      left: "50%",
      top: 0,
      width: "0.25rem",
      height: "0.25rem",
      transform: "translate(-50%, 0)",
      borderRadius: "0",
      backgroundColor: "rgb(253 230 138 / 1)",
    },
  },
  // absolute -left-1.5 top-0 z-20 h-full w-3 cursor-col-resize touch-none rounded-l-sm bg-transparent before:absolute before:inset-y-1 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:rounded-full before:bg-white/60 before:opacity-0 before:transition-opacity hover:before:bg-[#E8E044] hover:before:opacity-100 focus-visible:outline-none focus-visible:before:bg-[#E8E044] focus-visible:before:opacity-100 group-hover/clip:before:opacity-100 disabled:cursor-not-allowed disabled:before:bg-white/25
  absTallRaised: {
    position: "absolute",
    left: "-0.375rem",
    top: 0,
    zIndex: "20",
    height: "100%",
    width: "0.75rem",
    cursor: {
      default: "col-resize",
      ":disabled": "not-allowed",
    },
    touchAction: "none",
    borderTopLeftRadius: "0",
    borderBottomLeftRadius: "0",
    backgroundColor: "transparent",
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    "::before": {
      content: "''",
      position: "absolute",
      top: space.s1,
      bottom: space.s1,
      left: "50%",
      width: "0.125rem",
      transform: "translate(-50%, 0)",
      borderRadius: "0",
      // hover:before:bg-[#E8E044] focus-visible:before:bg-[#E8E044] disabled:before:bg-white/25
      backgroundColor: {
        default: "rgb(255 255 255 / 0.6)",
        ":hover": colors.accent,
        ":focus-visible": colors.accent,
        ":disabled": "rgb(255 255 255 / 0.25)",
      },
      // hover:before:opacity-100 focus-visible:before:opacity-100, and
      // `group-hover/clip:before:opacity-100` as the resting value: the clip
      // publishes `hovered.clipHandleOpacity`, because a class beside this rule
      // could never outrank the compiled `opacity` declaration.
      opacity: {
        default: hovered.clipHandleOpacity,
        ":hover": "1",
        ":focus-visible": "1",
      },
      transitionProperty: "opacity",
      transitionTimingFunction: motion.easeStandard,
      transitionDuration: "150ms",
    },
  },
  // flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden px-2 text-[8px] font-medium disabled:pointer-events-none
  flexCenterFill: {
    display: "flex",
    height: "100%",
    minWidth: "0px",
    flex: "1 1 0%",
    alignItems: "center",
    gap: space.s1,
    overflow: "hidden",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    fontSize: "8px",
    fontWeight: text.weightMedium,
    pointerEvents: {
      default: null,
      ":disabled": "none",
    },
  },
  // inline-flex h-3 shrink-0 items-center gap-0.5 rounded-sm border border-current/20 bg-black/15 px-0.5 text-[6px] font-semibold uppercase tracking-[0.04em]
  //
  // `border-current/20` is absent below because Tailwind v3 emits nothing for
  // it: the `current` colour is the literal `currentColor` keyword and takes no
  // alpha modifier. The border therefore always painted in `currentColor`, and
  // it still does — the preflight default — so the rule is complete as written.
  inlineFlexCenterTight: {
    display: "inline-flex",
    height: "0.75rem",
    flexShrink: "0",
    alignItems: "center",
    gap: space.s0_5,
    borderRadius: "0",
    borderWidth: "1px",
    backgroundColor: "rgb(0 0 0 / 0.15)",
    paddingLeft: space.s0_5,
    paddingRight: space.s0_5,
    fontSize: "6px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  // size-1.5
  size15: {
    width: "0.375rem",
    height: "0.375rem",
  },
  // size-2.5 shrink-0
  tight3: {
    width: "0.625rem",
    height: "0.625rem",
    flexShrink: "0",
  },
  // truncate
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // ml-auto size-2.5 shrink-0
  tightPushRight: {
    marginLeft: "auto",
    width: "0.625rem",
    height: "0.625rem",
    flexShrink: "0",
  },
  resizeEnd: { left: "auto", right: "-0.375rem" },
  // fixed z-[90] overflow-y-auto rounded-2xl border border-white/15 bg-[linear-gradient(150deg,rgba(30,30,27,0.98),rgba(10,10,10,0.98))] p-3 text-white shadow-[0_24px_80px_rgba(0,0,0,0.72),0_0_0_1px_rgba(232,224,68,0.12)] backdrop-blur-2xl
  fixedWhiteBordered: {
    position: "fixed",
    zIndex: layers.editorTop,
    overflowY: "auto",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundImage: "linear-gradient(150deg, rgba(30, 30, 27, 0.98), rgba(10, 10, 10, 0.98))",
    padding: space.s3,
    color: "rgb(255 255 255 / 1)",
    boxShadow: "0 24px 80px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(232, 224, 68, 0.12)",
    backdropFilter: "blur(40px)",
  },
  // mb-3 flex items-start gap-3 border-b border-white/10 pb-2.5
  flexStartRuleB: {
    marginBottom: space.s3,
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
    borderBottomWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingBottom: "0.625rem",
  },
  // mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-[#E8E044]/30 bg-[#E8E044]/10 text-[#E8E044]
  gridCenteredTight2: {
    marginTop: space.s0_5,
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: "0",
    placeItems: "center",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(232 224 68 / 0.3)",
    backgroundColor: "rgb(232 224 68 / 0.1)",
    color: colors.accent,
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // text-[10px] font-semibold uppercase tracking-[0.16em] text-[#E8E044]
  capsSemibold: {
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: colors.accent,
  },
  // mt-0.5 truncate text-xs text-white/60
  xsTruncate: {
    marginTop: space.s0_5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.6)",
  },
  // grid size-7 place-items-center rounded-lg text-lg leading-none text-white/45 hover:bg-white/10 hover:text-white
  gridCenteredLg: {
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    placeItems: "center",
    borderRadius: "0",
    fontSize: text.sizeLg,
    lineHeight: "1",
    color: {
      default: "rgb(255 255 255 / 0.45)",
      ":hover": "rgb(255 255 255 / 1)",
    },
    backgroundColor: {
      default: null,
      ":hover": colors.fillStrong,
    },
  },
  // grid gap-2 sm:grid-cols-2
  gridGap2: {
    display: "grid",
    gap: space.s2,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  // flex items-center gap-1.5
  flexCenterGap155: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
  },
  // size-3.5 shrink-0
  tight4: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: "0",
  },
  // sm:col-span-2
  smColSpan2: {
    gridColumn: {
      default: null,
      "@media (min-width: 640px)": "span 2 / span 2",
    },
  },
  // rounded-xl border border-white/10 bg-white/[0.035] p-2
  borderedPad2: {
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(255 255 255 / 0.035)",
    padding: space.s2,
  },
  // mb-1.5 px-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/40
  capsSemibold2: {
    marginBottom: space.s1_5,
    paddingLeft: space.s1,
    paddingRight: space.s1,
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.15em",
    color: "rgb(255 255 255 / 0.4)",
  },
  // grid grid-cols-2 gap-1
  gridCols2Gap1: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s1,
  },
  // min-h-8 rounded-lg border border-transparent bg-black/20 px-2 py-1.5 text-left text-[10px] leading-tight text-white/70 hover:border-[#E8E044]/35 hover:bg-[#E8E044]/10 hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  borderedLeftText: {
    minHeight: "2rem",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: {
      default: "transparent",
      ":hover": "rgb(232 224 68 / 0.35)",
    },
    backgroundColor: {
      default: "rgb(0 0 0 / 0.2)",
      ":hover": "rgb(232 224 68 / 0.1)",
    },
    paddingLeft: space.s2,
    paddingRight: space.s2,
    paddingTop: space.s1_5,
    paddingBottom: space.s1_5,
    textAlign: "left",
    fontSize: "10px",
    lineHeight: "1.25",
    color: {
      default: "rgb(255 255 255 / 0.7)",
      ":hover": colors.accent,
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
  },
  // mt-0.5 size-4 shrink-0 text-[#E8E044]
  tight5: {
    marginTop: space.s0_5,
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    color: colors.accent,
  },
  // z-30 flex min-h-0 w-full shrink-0 flex-col text-white
  flexColTight: {
    zIndex: layers.sticky,
    display: "flex",
    minHeight: "0px",
    width: "100%",
    flexShrink: "0",
    flexDirection: "column",
    color: "rgb(255 255 255 / 1)",
  },
  // inline gridColumn: 2 gridRow: 1
  styleGridColumn2: {
    gridColumn: 2,
    gridRow: 1,
  },

  // absolute inset-y-0 flex min-w-px items-center justify-center overflow-hidden border disabled:pointer-events-none
  signalBand: {
    position: "absolute",
    top: 0,
    bottom: 0,
    display: "flex",
    minWidth: "1px",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: "1px",
    pointerEvents: {
      default: null,
      ":disabled": "none",
    },
  },
  // border-dashed border-white/20
  signalBandBaseline: {
    borderStyle: "dashed",
    borderColor: "rgb(255 255 255 / 0.2)",
  },
  // cursor-pointer
  signalBandSelectable: {
    cursor: "pointer",
  },
  // cursor-default
  signalBandInert: {
    cursor: "default",
  },

  // relative z-10 flex min-w-0 items-start overflow-hidden border-r border-white/10
  identityColumn: {
    position: "relative",
    zIndex: layers.raised,
    display: "flex",
    minWidth: "0px",
    alignItems: "flex-start",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderColor: colors.fillStrong,
  },
  // bg-[#E8E044]/10 text-[#E8E044]
  identityColumnSelected: {
    backgroundColor: "rgb(232 224 68 / 0.1)",
    color: colors.accent,
  },
  // bg-black/20 text-white/75
  identityColumnIdle: {
    backgroundColor: "rgb(0 0 0 / 0.2)",
    color: "rgb(255 255 255 / 0.75)",
  },
  // absolute inset-y-1 overflow-hidden rounded-md border px-2 text-left text-[8px]
  reasoningClip: {
    position: "absolute",
    top: space.s1,
    bottom: space.s1,
    overflow: "hidden",
    borderRadius: "0",
    borderWidth: "1px",
    paddingLeft: space.s2,
    paddingRight: space.s2,
    textAlign: "left",
    fontSize: "8px",
  },
  // border-white bg-[#E8E044] text-black ring-1 ring-white
  reasoningClipSelected: {
    borderColor: "rgb(255 255 255 / 1)",
    backgroundColor: colors.accent,
    color: "rgb(0 0 0 / 1)",
    boxShadow: "0 0 0 1px rgb(255 255 255 / 1)",
  },
  // border-[#E8E044]/70 bg-[#E8E044]/25 text-[#E8E044]
  reasoningClipIdle: {
    borderColor: "rgb(232 224 68 / 0.7)",
    backgroundColor: "rgb(232 224 68 / 0.25)",
    color: colors.accent,
  },
  // h-24 px-4 py-3 — this panel's preview frame.
  preview: {
    height: "6rem",
    paddingLeft: space.s4,
    paddingRight: space.s4,
    paddingTop: space.s3,
    paddingBottom: space.s3,
  },
  // mt-0.5 h-3.5 w-6 shrink-0 text-[#E8E044]
  catalogIcon: {
    marginTop: space.s0_5,
    height: "0.875rem",
    width: "1.5rem",
    flexShrink: "0",
    color: colors.accent,
  },

  // absolute inset-y-1 flex min-w-4 overflow-visible rounded-[3px] border
  //
  // The `group/clip` marker is gone: the two resize handles read
  // `hovered.clipHandleOpacity`, which this rule publishes on `:hover`.
  //
  // `ring-1 ring-white` and the per-state `shadow-[…]` used to land on the same
  // `box-shadow` through Tailwind's `--tw-ring-shadow` / `--tw-shadow` pair, so
  // the two could be set independently. The same split is kept here with two
  // custom properties: the state variants set the glow, `clipSelected` sets the
  // ring, and neither has to know about the other.
  clip: {
    "--v1-clip-ring": "0 0 #0000",
    "--v1-clip-shadow": "0 0 #0000",
    position: "absolute",
    top: space.s1,
    bottom: space.s1,
    display: "flex",
    minWidth: "1rem",
    overflow: "visible",
    borderRadius: "0",
    borderWidth: "1px",
    boxShadow: "var(--v1-clip-ring), var(--v1-clip-shadow)",
    [hovered.clipHandleOpacity]: "0",
    ":hover": {
      [hovered.clipHandleOpacity]: "1",
    },
  },
  // z-10 ring-1 ring-white
  clipSelected: {
    "--v1-clip-ring": "0 0 0 1px rgb(255 255 255 / 1)",
    zIndex: layers.raised,
  },
  // animate-pulse border-red-300 bg-red-500/45 text-red-50 shadow-[0_0_12px_rgba(248,113,113,0.45)] motion-reduce:animate-none
  clipNeedsSetup: {
    "--v1-clip-shadow": "0 0 12px rgba(248,113,113,0.45)",
    animationName: {
      default: pulse,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
    borderColor: "rgb(252 165 165 / 1)",
    backgroundColor: "rgb(239 68 68 / 0.45)",
    color: "rgb(254 242 242 / 1)",
  },
  // border-red-300 bg-red-400/25 text-red-50 shadow-[0_0_8px_rgba(252,165,165,0.2)]
  clipConflict: {
    "--v1-clip-shadow": "0 0 8px rgba(252,165,165,0.2)",
    borderColor: "rgb(252 165 165 / 1)",
    backgroundColor: "rgb(248 113 113 / 0.25)",
    color: "rgb(254 242 242 / 1)",
  },
  // border-amber-300/80 bg-amber-300/20 text-amber-50
  clipPossible: {
    borderColor: "rgb(252 211 77 / 0.8)",
    backgroundColor: "rgb(252 211 77 / 0.2)",
    color: "rgb(255 251 235 / 1)",
  },
  // border-dashed border-[#E8E044]/60 bg-[#E8E044]/15
  clipArmed: {
    borderStyle: "dashed",
    borderColor: "rgb(232 224 68 / 0.6)",
    backgroundColor: "rgb(232 224 68 / 0.15)",
  },
  // border-[#E8E044]/80 bg-[#E8E044]/65 text-black
  clipAuthored: {
    borderColor: "rgb(232 224 68 / 0.8)",
    backgroundColor: "rgb(232 224 68 / 0.65)",
    color: "rgb(0 0 0 / 1)",
  },
  // z-30 flex min-h-0 w-full shrink-0 flex-col text-white
  scenarioTimelineDock: {
    zIndex: layers.sticky,
    display: "flex",
    minHeight: 0,
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    color: "rgb(255 255 255 / 1)",
  },
  // absolute left-1/2 top-0 z-40 flex h-3 w-24 -translate-x-1/2 cursor-ns-resize touch-none items-start justify-center pt-1
  timelineHeightResizeHandle: {
    position: "absolute",
    left: "50%",
    top: "0",
    zIndex: 40,
    display: "flex",
    height: space.s3,
    width: "6rem",
    transform: "translateX(-50%)",
    cursor: "ns-resize",
    touchAction: "none",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: space.s1,
  },
  // h-1 w-10 rounded-full bg-white/35 transition-colors hover:bg-[#E8E044]/70
  span: {
    height: space.s1,
    width: "2.5rem",
    backgroundColor: { default: "rgb(255 255 255 / 0.35)", ":hover": "rgb(232 224 68 / 0.7)" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  // group absolute inset-y-0 z-40 -ml-1.5 w-3 cursor-col-resize touch-none
  timelineSplitResizeHandle: {
    position: "absolute",
    top: "0",
    bottom: "0",
    zIndex: 40,
    marginLeft: `calc(-1 * ${space.s1_5})`,
    width: space.s3,
    cursor: "col-resize",
    touchAction: "none",
  },
  // relative z-10 grid h-12 shrink-0 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] overflow-hidden rounded-t-[24px] border-b border-white/10 bg-gradient-to-r from-[#E8E044]/[0.07] via-white/[0.025] to-transparent
  timelineTopbar: {
    position: "relative",
    zIndex: layers.raised,
    display: "grid",
    height: "3rem",
    flexShrink: 0,
    gridTemplateColumns: "var(--timeline-identity-width) minmax(0,1fr)",
    overflow: "hidden",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundImage: `linear-gradient(to right, rgb(232 224 68 / 0.07), rgb(255 255 255 / 0.025), transparent)`,
  },
  // flex min-w-0 items-center justify-center overflow-hidden border-r border-white/10
  divFlex: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
  },
  // flex w-max flex-col items-center justify-center gap-0.5 px-2
  divFlex2: {
    display: "flex",
    width: "max-content",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s0_5,
    paddingInline: space.s2,
  },
  // whitespace-nowrap text-center text-[8px] font-bold uppercase tracking-[0.12em] text-[#E8E044]
  timeline: {
    whiteSpace: "nowrap",
    textAlign: "center",
    fontSize: "8px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    color: colors.accent,
  },
  // relative min-w-0 self-stretch cursor-pointer
  timelineInlineRuler: {
    position: "relative",
    minWidth: 0,
    alignSelf: "stretch",
    cursor: "pointer",
  },
  // mb-0 h-full border-b-0 bg-black/20
  timelineruler: {
    marginBottom: "0",
    height: "100%",
    borderBottomWidth: 0,
    backgroundColor: "rgb(0 0 0 / 0.2)",
  },
  // pointer-events-none absolute inset-y-0 z-20 w-px bg-[#E8E044] shadow-[0_0_10px_rgba(232,224,68,0.65)]
  timelinePlayhead: {
    pointerEvents: "none",
    position: "absolute",
    top: "0",
    bottom: "0",
    zIndex: 20,
    width: "1px",
    backgroundColor: colors.accent,
    boxShadow: "0 0 10px rgba(232,224,68,0.65)",
  },
  // group pointer-events-auto absolute -left-2 inset-y-0 w-4 cursor-ew-resize touch-none bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  timelinePlayheadDragHandleButton: {
    pointerEvents: "auto",
    position: "absolute",
    left: `calc(-1 * ${space.s2})`,
    top: "0",
    bottom: "0",
    width: space.s4,
    cursor: "ew-resize",
    touchAction: "none",
    backgroundColor: "transparent",
    padding: "0",
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.accent}` },
  },
  // relative z-10 min-h-0 flex-1 overflow-hidden bg-black/10
  semanticTimeline: {
    position: "relative",
    zIndex: layers.raised,
    minHeight: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    backgroundColor: "rgb(0 0 0 / 0.1)",
  },
  // absolute inset-0 overflow-y-auto
  divAbsolute: {
    position: "absolute",
    inset: "0",
    overflowY: "auto",
  },
  // min-h-full pb-12
  div: {
    minHeight: "100%",
    paddingBottom: "3rem",
  },
  // m-3 grid h-24 place-items-center border border-dashed border-white/15 px-4 text-center text-xs text-white/35
  pGridXs: {
    margin: space.s3,
    display: "grid",
    height: "6rem",
    placeItems: "center",
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: "rgb(255 255 255 / 0.15)",
    paddingInline: space.s4,
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.35)",
  },
  // grid h-10 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] border-b border-white/10 bg-black/20
  timelineSignalLane: {
    display: "grid",
    height: "2.5rem",
    gridTemplateColumns: "var(--timeline-identity-width) minmax(0,1fr)",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(0 0 0 / 0.2)",
  },
  // flex min-w-0 items-stretch overflow-hidden border-r border-white/10 bg-[#E8E044]/[0.06]
  divFlex3: {
    display: "flex",
    minWidth: 0,
    alignItems: "stretch",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(232 224 68 / 0.06)",
  },
  // flex w-max items-stretch self-stretch
  divFlex4: {
    display: "flex",
    width: "max-content",
    alignItems: "stretch",
    alignSelf: "stretch",
  },
  // editor-motion flex items-center gap-1.5 px-2 text-left text-[9px] text-[#E8E044] hover:bg-[#E8E044]/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#E8E044]
  timelineFocusSignalButton: {
    transitionProperty: { default: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity", "@media (prefers-reduced-motion: reduce)": "none" },
    transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    transitionDuration: { default: "150ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s2,
    textAlign: "left",
    fontSize: "9px",
    color: colors.accent,
    backgroundColor: { default: null, ":hover": "rgb(232 224 68 / 0.1)" },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `inset 0 0 0 1px ${colors.accent}` },
  },
  // size-3 shrink-0
  trafficconeIcon: {
    width: space.s3,
    height: space.s3,
    flexShrink: 0,
  },
  // whitespace-nowrap
  light: {
    whiteSpace: "nowrap",
  },
  // flex items-center gap-1.5 px-2 text-[9px] text-[#E8E044]/80
  divFlex5: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s2,
    fontSize: "9px",
    color: "rgb(232 224 68 / 0.8)",
  },
  // size-3 shrink-0
  trafficconeIcon2: {
    width: space.s3,
    height: space.s3,
    flexShrink: 0,
  },
  // whitespace-nowrap
  lights: {
    whiteSpace: "nowrap",
  },
  // editor-motion grid w-6 shrink-0 place-items-center border-l border-white/10 text-white/35 hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-red-300
  timelineRemoveSignalControlButton: {
    transitionProperty: { default: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity", "@media (prefers-reduced-motion: reduce)": "none" },
    transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    transitionDuration: { default: "150ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    display: "grid",
    width: space.s6,
    flexShrink: 0,
    placeItems: "center",
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    color: { default: "rgb(255 255 255 / 0.35)", ":hover": "rgb(252 165 165 / 1)" },
    backgroundColor: { default: null, ":hover": "rgb(239 68 68 / 0.15)" },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `inset 0 0 0 1px rgb(252 165 165 / 1)` },
  },
  // size-3
  trash2Icon: {
    width: space.s3,
    height: space.s3,
  },
  // relative my-2 cursor-pointer overflow-hidden bg-white/[0.025]
  divRelative: {
    position: "relative",
    marginBlock: space.s2,
    cursor: "pointer",
    overflow: "hidden",
    backgroundColor: "rgb(255 255 255 / 0.025)",
  },
  // grid border-b border-white/10
  timelineWorldLane: {
    display: "grid",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
  },
  // relative z-10 flex min-w-0 items-start overflow-hidden border-r border-white/10 bg-[#E8E044]/[0.04] text-[#E8E044]/80
  timelineWorldIdentity: {
    position: "relative",
    zIndex: layers.raised,
    display: "flex",
    minWidth: 0,
    alignItems: "flex-start",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(232 224 68 / 0.04)",
    color: "rgb(232 224 68 / 0.8)",
  },
  // flex w-max items-start gap-1.5 px-2 py-2
  divFlex6: {
    display: "flex",
    width: "max-content",
    alignItems: "flex-start",
    gap: space.s1_5,
    paddingInline: space.s2,
    paddingBlock: space.s2,
  },
  // mt-0.5 size-3 shrink-0
  globe2Icon: {
    marginTop: space.s0_5,
    width: space.s3,
    height: space.s3,
    flexShrink: 0,
  },
  // whitespace-nowrap text-[9px] font-medium
  scene: {
    whiteSpace: "nowrap",
    fontSize: "9px",
    fontWeight: text.weightMedium,
  },
  // grid border-b border-white/10
  timelineActorLane: {
    display: "grid",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
  },
  // flex w-max items-start gap-1.5 px-2 py-2
  divFlex7: {
    display: "flex",
    width: "max-content",
    alignItems: "flex-start",
    gap: space.s1_5,
    paddingInline: space.s2,
    paddingBlock: space.s2,
  },
  // flex items-center gap-1.5 rounded-sm text-left enabled:cursor-pointer enabled:hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#E8E044]
  focusActorButton: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    textAlign: "left",
    cursor: { default: null, ":enabled": "pointer" },
    color: { default: null, ":enabled:hover": "rgb(255 255 255 / 1)" },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 1px ${colors.accent}` },
  },
  // whitespace-nowrap text-[9px] font-medium
  spanMedium: {
    whiteSpace: "nowrap",
    fontSize: "9px",
    fontWeight: text.weightMedium,
  },
  // inline-flex size-4 shrink-0 items-center justify-center bg-transparent p-0 text-white/35 transition-colors hover:bg-transparent hover:text-red-300 focus-visible:bg-transparent focus-visible:text-red-300 focus-visible:outline-none
  timelineDeleteButton: {
    display: "inline-flex",
    width: space.s4,
    height: space.s4,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: { default: "transparent", ":hover": "transparent", ":focus-visible": "transparent" },
    padding: "0",
    color: { default: "rgb(255 255 255 / 0.35)", ":hover": "rgb(252 165 165 / 1)", ":focus-visible": "rgb(252 165 165 / 1)" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  // size-3.5
  trash2Icon2: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // flex cursor-pointer items-center px-2 text-[9px] uppercase tracking-[0.12em] text-white/25
  timelineStaticIdentityOnly: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    paddingInline: space.s2,
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    color: "rgb(255 255 255 / 0.25)",
  },
  // relative cursor-pointer bg-black/15
  timelineInteractionGap: {
    position: "relative",
    cursor: "pointer",
    backgroundColor: "rgb(0 0 0 / 0.15)",
  },
  // absolute inset-0 grid place-items-center text-[8px] text-white/20
  spanAbsoluteGrid: {
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    fontSize: "8px",
    color: "rgb(255 255 255 / 0.2)",
  },
  // grid h-10 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] border-b border-white/10 bg-[#E8E044]/[0.025]
  timelineReasoningTraceLane: {
    display: "grid",
    height: "2.5rem",
    gridTemplateColumns: "var(--timeline-identity-width) minmax(0,1fr)",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(232 224 68 / 0.025)",
  },
  // flex min-w-0 items-center overflow-hidden border-r border-white/10 text-[#E8E044]/80
  divFlex8: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    overflow: "hidden",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    color: "rgb(232 224 68 / 0.8)",
  },
  // flex w-max items-center gap-1.5 px-2
  divFlex9: {
    display: "flex",
    width: "max-content",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s2,
  },
  // size-3 shrink-0
  braincircuitIcon: {
    width: space.s3,
    height: space.s3,
    flexShrink: 0,
  },
  // whitespace-nowrap text-[8px] font-semibold uppercase tracking-[0.08em]
  reasoning: {
    whiteSpace: "nowrap",
    fontSize: "8px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  // relative cursor-pointer bg-black/15
  divRelative2: {
    position: "relative",
    cursor: "pointer",
    backgroundColor: "rgb(0 0 0 / 0.15)",
  },
  // absolute inset-0 grid place-items-center text-[8px] text-white/20
  spanAbsoluteGrid2: {
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    fontSize: "8px",
    color: "rgb(255 255 255 / 0.2)",
  },
  // block truncate
  spanTruncate: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // flex flex-col items-center gap-1 text-center
  divFlex10: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s1,
    textAlign: "center",
  },
  // size-8 text-[#E8E044]
  braincircuitIcon2: {
    width: space.s8,
    height: space.s8,
    color: colors.accent,
  },
  // text-[10px] font-semibold text-white
  reasoningTrace: {
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    color: "rgb(255 255 255 / 1)",
  },
  // text-[8px] text-white/40
  observationAndAction: {
    fontSize: "8px",
    color: "rgb(255 255 255 / 0.4)",
  },
  // grid grid-cols-2 gap-2
  divGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s2,
  },
  // min-w-0 text-[8px] uppercase tracking-[0.1em] text-white/45
  labelUppercase: {
    minWidth: 0,
    fontSize: "8px",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-1 h-8 w-full min-w-0 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] normal-case text-white outline-none focus:border-[#E8E044]/60
  input: {
    marginTop: space.s1,
    height: space.s8,
    width: "100%",
    minWidth: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "rgb(255 255 255 / 0.1)", ":focus": "rgb(232 224 68 / 0.6)" },
    backgroundColor: "rgb(255 255 255 / 0.04)",
    paddingInline: space.s2,
    fontSize: "10px",
    textTransform: "none",
    color: "rgb(255 255 255 / 1)",
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // block text-[8px] uppercase tracking-[0.1em] text-white/45
  observation: {
    display: "block",
    fontSize: "8px",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-1 min-h-24 w-full resize-y rounded-md border border-white/10 bg-white/[0.04] p-2 text-[10px] normal-case leading-relaxed text-white outline-none focus:border-[#E8E044]/60
  textarea: {
    marginTop: space.s1,
    minHeight: "6rem",
    width: "100%",
    resize: "vertical",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "rgb(255 255 255 / 0.1)", ":focus": "rgb(232 224 68 / 0.6)" },
    backgroundColor: "rgb(255 255 255 / 0.04)",
    padding: space.s2,
    fontSize: "10px",
    textTransform: "none",
    lineHeight: "1.625",
    color: "rgb(255 255 255 / 1)",
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // block text-[8px] uppercase tracking-[0.1em] text-white/45
  action: {
    display: "block",
    fontSize: "8px",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: "rgb(255 255 255 / 0.45)",
  },
  // mt-1 min-h-24 w-full resize-y rounded-md border border-white/10 bg-white/[0.04] p-2 text-[10px] normal-case leading-relaxed text-white outline-none focus:border-[#E8E044]/60
  textarea2: {
    marginTop: space.s1,
    minHeight: "6rem",
    width: "100%",
    resize: "vertical",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "rgb(255 255 255 / 0.1)", ":focus": "rgb(232 224 68 / 0.6)" },
    backgroundColor: "rgb(255 255 255 / 0.04)",
    padding: space.s2,
    fontSize: "10px",
    textTransform: "none",
    lineHeight: "1.625",
    color: "rgb(255 255 255 / 1)",
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // grid grid-cols-1 gap-1.5 border-t border-white/10 pt-3
  divGrid2: {
    display: "grid",
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    gap: space.s1_5,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.s3,
  },
  // h-8 rounded-md bg-[#E8E044] px-3 text-[10px] font-semibold text-black disabled:opacity-40
  saveTraceButton: {
    height: space.s8,
    backgroundColor: colors.accent,
    paddingInline: space.s3,
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    color: "rgb(0 0 0 / 1)",
    opacity: { default: null, ":disabled": 0.4 },
  },
  // flex h-8 items-center justify-center gap-1.5 rounded-md border border-red-300/20 text-[9px] text-red-200 hover:bg-red-300/10
  buttonFlex: {
    display: "flex",
    height: space.s8,
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1_5,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgb(252 165 165 / 0.2)",
    fontSize: "9px",
    color: "rgb(254 202 202 / 1)",
    backgroundColor: { default: null, ":hover": "rgb(252 165 165 / 0.1)" },
  },
  // size-3
  deleteTraceTrash2: {
    width: space.s3,
    height: space.s3,
  },
  // relative cursor-pointer overflow-hidden bg-black/15
  interactionRow: {
    position: "relative",
    cursor: "pointer",
    overflow: "hidden",
    backgroundColor: "rgb(0 0 0 / 0.15)",
  },
  // contents
  interactionTrack: {
    display: "contents",
  },
  // absolute inset-x-0 top-1/2 h-px bg-white/[0.06]
  divAbsolute2: {
    position: "absolute",
    left: "0",
    right: "0",
    top: "50%",
    height: "1px",
    backgroundColor: "rgb(255 255 255 / 0.06)",
  },
  // pointer-events-none absolute inset-y-0 z-[5] w-px -translate-x-1/2 bg-amber-300/80 shadow-[0_0_6px_rgba(252,211,77,0.45)] before:absolute before:left-1/2 before:top-0 before:size-1 before:-translate-x-1/2 before:rounded-full before:bg-amber-200
  timelineTriggerDeadline: {
    pointerEvents: "none",
    position: "absolute",
    top: "0",
    bottom: "0",
    zIndex: 5,
    width: "1px",
    transform: "translateX(-50%)",
    backgroundColor: "rgb(252 211 77 / 0.8)",
    boxShadow: "0 0 6px rgba(252,211,77,0.45)",
    "::before": { content: "", position: "absolute", left: "50%", top: "0", width: space.s1, height: space.s1, transform: "translateX(-50%)", backgroundColor: "rgb(254 240 138 / 1)" },
  },
  // flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden px-2 text-[8px] font-medium disabled:pointer-events-none
  interactionExpandButton: {
    display: "flex",
    height: "100%",
    minWidth: 0,
    flex: "1 1 0%",
    alignItems: "center",
    gap: space.s1,
    overflow: "hidden",
    paddingInline: space.s2,
    fontSize: "8px",
    fontWeight: text.weightMedium,
    pointerEvents: { default: null, ":disabled": "none" },
  },
  // inline-flex h-3 shrink-0 items-center gap-0.5 rounded-sm border border-current/20 bg-black/15 px-0.5 text-[6px] font-semibold uppercase tracking-[0.04em]
  timelineCause: {
    display: "inline-flex",
    height: space.s3,
    flexShrink: 0,
    alignItems: "center",
    gap: space.s0_5,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "color-mix(in srgb, currentColor 20%, transparent)",
    backgroundColor: "rgb(0 0 0 / 0.15)",
    paddingInline: space.s0_5,
    fontSize: "6px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  // size-1.5
  clock3Icon: {
    width: space.s1_5,
    height: space.s1_5,
  },
  // size-1.5
  zapIcon: {
    width: space.s1_5,
    height: space.s1_5,
  },
  // size-2.5 shrink-0
  lockIcon: {
    width: "0.625rem",
    height: "0.625rem",
    flexShrink: 0,
  },
  // truncate
  spanTruncate2: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // ml-auto size-2.5 shrink-0
  timelineConflictAlertTriangle: {
    marginLeft: "auto",
    width: "0.625rem",
    height: "0.625rem",
    flexShrink: 0,
  },
  // fixed z-[90] overflow-y-auto rounded-2xl border border-white/15 bg-[linear-gradient(150deg,rgba(30,30,27,0.98),rgba(10,10,10,0.98))] p-3 text-white shadow-[0_24px_80px_rgba(0,0,0,0.72),0_0_0_1px_rgba(232,224,68,0.12)] backdrop-blur-2xl
  timelineContextMenu: {
    position: "fixed",
    zIndex: layers.editorTop,
    overflowY: "auto",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundImage: "linear-gradient(150deg,rgba(30,30,27,0.98),rgba(10,10,10,0.98))",
    padding: space.s3,
    color: "rgb(255 255 255 / 1)",
    boxShadow: "0 24px 80px rgba(0,0,0,0.72),0 0 0 1px rgba(232,224,68,0.12)",
    backdropFilter: "blur(40px)",
  },
  // mb-3 flex items-start gap-3 border-b border-white/10 pb-2.5
  headerFlex: {
    marginBottom: space.s3,
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingBottom: "0.625rem",
  },
  // mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-[#E8E044]/30 bg-[#E8E044]/10 text-[#E8E044]
  spanGridIcon: {
    marginTop: space.s0_5,
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: 0,
    placeItems: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgb(232 224 68 / 0.3)",
    backgroundColor: "rgb(232 224 68 / 0.1)",
    color: colors.accent,
  },
  // size-4
  plusIcon: {
    width: space.s4,
    height: space.s4,
  },
  // min-w-0 flex-1
  div2: {
    minWidth: 0,
    flex: "1 1 0%",
  },
  // text-[10px] font-semibold uppercase tracking-[0.16em] text-[#E8E044]
  addAt: {
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.16em",
    color: colors.accent,
  },
  // mt-0.5 truncate text-xs text-white/60
  pTruncateXs: {
    marginTop: space.s0_5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.6)",
  },
  // grid size-7 place-items-center rounded-lg text-lg leading-none text-white/45 hover:bg-white/10 hover:text-white
  closeActionMenuButton: {
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    placeItems: "center",
    fontSize: text.sizeLg,
    lineHeight: "1",
    color: { default: "rgb(255 255 255 / 0.45)", ":hover": "rgb(255 255 255 / 1)" },
    backgroundColor: { default: null, ":hover": "rgb(255 255 255 / 0.1)" },
  },
  // grid gap-2 sm:grid-cols-2
  divGrid3: {
    display: "grid",
    gap: space.s2,
    gridTemplateColumns: { default: null, "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))" },
  },
  // flex items-center gap-1.5
  spanFlex: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
  },
  // size-3.5 shrink-0
  routeiconIcon: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
  },
  // size-3.5 shrink-0
  gamepad2Icon: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
  },
  // sm:col-span-2
  div3: {
    gridColumn: { default: null, "@media (min-width: 640px)": "span 2 / span 2" },
  },
  // rounded-xl border border-white/10 bg-white/[0.035] p-2
  timelineContextGroup: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    backgroundColor: "rgb(255 255 255 / 0.035)",
    padding: space.s2,
  },
  // mb-1.5 px-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/40
  h3SemiboldUppercase: {
    marginBottom: space.s1_5,
    paddingInline: space.s1,
    fontSize: "9px",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.15em",
    color: "rgb(255 255 255 / 0.4)",
  },
  // grid grid-cols-2 gap-1
  divGrid4: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s1,
  },
  // min-h-8 rounded-lg border border-transparent bg-black/20 px-2 py-1.5 text-left text-[10px] leading-tight text-white/70 hover:border-[#E8E044]/35 hover:bg-[#E8E044]/10 hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  menuitemButton: {
    minHeight: space.s8,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "transparent", ":hover": "rgb(232 224 68 / 0.35)" },
    backgroundColor: { default: "rgb(0 0 0 / 0.2)", ":hover": "rgb(232 224 68 / 0.1)" },
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    textAlign: "left",
    fontSize: "10px",
    lineHeight: text.lineTight,
    color: { default: "rgb(255 255 255 / 0.7)", ":hover": colors.accent },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.accent}` },
  },
  // mt-0.5 size-4 shrink-0 text-[#E8E044]
  timelineActorIcon: {
    marginTop: space.s0_5,
    width: space.s4,
    height: space.s4,
    flexShrink: 0,
    color: colors.accent,
  },
  // mt-0.5 size-3 shrink-0
  timelineActorIconPersonStanding: {
    marginTop: space.s0_5,
    width: space.s3,
    height: space.s3,
    flexShrink: 0,
  },
  // mt-0.5 size-3 shrink-0
  timelineActorIconBox: {
    marginTop: space.s0_5,
    width: space.s3,
    height: space.s3,
    flexShrink: 0,
  },
  // mt-0.5 size-3 shrink-0
  timelineActorIconCarFront: {
    marginTop: space.s0_5,
    width: space.s3,
    height: space.s3,
    flexShrink: 0,
  },
});
