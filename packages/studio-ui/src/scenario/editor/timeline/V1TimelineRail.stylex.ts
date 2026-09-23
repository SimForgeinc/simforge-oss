import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, motion, space, stroke, text } from "../../../stylex/tokens.stylex";

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
    backgroundColor: colors.accent,
    boxShadow: "0 0 10px rgba(232, 224, 68, 0.55)",
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
    backgroundColor: "transparent",
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
      transitionDuration: motion.durStandard,
    },
  },
  resizeEnd: { left: "auto", right: "-0.375rem" },

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
    borderWidth: stroke.hairline,
    pointerEvents: {
      default: null,
      ":disabled": "none",
    },
  },
  // border-dashed border-white/20
  signalBandBaseline: {
    borderStyle: "dashed",
    borderColor: colors.hairlineStrong,
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
    borderRightWidth: stroke.hairline,
    borderColor: colors.fillStrong,
  },
  // bg-[#E8E044]/10 text-[#E8E044]
  identityColumnSelected: {
    backgroundColor: colors.accentWash,
    color: colors.accent,
  },
  // bg-black/20 text-white/75
  identityColumnIdle: {
    backgroundColor: colors.scrimLight,
    color: colors.inkSecondary,
  },
  // absolute inset-y-1 overflow-hidden rounded-md border px-2 text-left text-[8px]
  reasoningClip: {
    position: "absolute",
    top: space.s1,
    bottom: space.s1,
    overflow: "hidden",
    borderWidth: stroke.hairline,
    paddingLeft: space.s2,
    paddingRight: space.s2,
    textAlign: "left",
    fontSize: text.sizeNano,
  },
  // border-white bg-[#E8E044] text-black ring-1 ring-white
  reasoningClipSelected: {
    borderColor: colors.hairlineStrong,
    backgroundColor: colors.accent,
    color: "rgb(0 0 0 / 1)",
    boxShadow: "0 0 0 1px rgb(255 255 255 / 1)",
  },
  // border-[#E8E044]/70 bg-[#E8E044]/25 text-[#E8E044]
  reasoningClipIdle: {
    borderColor: colors.accentLine,
    backgroundColor: "rgb(232 224 68 / 0.25)",
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
    borderWidth: stroke.hairline,
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
      [layout.reducedMotion]: "none",
    },
    animationDuration: motion.durPulse,
    animationTimingFunction: motion.easePulse,
    animationIterationCount: "infinite",
    borderColor: colors.critical,
    backgroundColor: "rgb(239 68 68 / 0.45)",
    color: "rgb(254 242 242 / 1)",
  },
  // border-red-300 bg-red-400/25 text-red-50 shadow-[0_0_8px_rgba(252,165,165,0.2)]
  clipConflict: {
    "--v1-clip-shadow": "0 0 8px rgba(252,165,165,0.2)",
    borderColor: colors.critical,
    backgroundColor: colors.criticalWash,
    color: "rgb(254 242 242 / 1)",
  },
  // border-amber-300/80 bg-amber-300/20 text-amber-50
  clipPossible: {
    borderColor: colors.warning,
    backgroundColor: colors.warningWash,
    color: "rgb(255 251 235 / 1)",
  },
  // border-dashed border-[#E8E044]/60 bg-[#E8E044]/15
  clipArmed: {
    borderStyle: "dashed",
    borderColor: colors.accentLine,
    backgroundColor: colors.accentWash,
  },
  // border-[#E8E044]/80 bg-[#E8E044]/65 text-black
  clipAuthored: {
    borderColor: colors.accentLine,
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
    color: colors.ink,
  },
  // absolute left-1/2 top-0 z-40 flex h-3 w-24 -translate-x-1/2 cursor-ns-resize touch-none items-start justify-center pt-1
  timelineHeightResizeHandle: {
    position: "absolute",
    left: "50%",
    top: "0",
    zIndex: layers.overlay,
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
  },
  // group absolute inset-y-0 z-40 -ml-1.5 w-3 cursor-col-resize touch-none
  timelineSplitResizeHandle: {
    position: "absolute",
    top: "0",
    bottom: "0",
    zIndex: layers.overlay,
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
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
    backgroundImage: `linear-gradient(to right, rgb(232 224 68 / 0.07), rgb(255 255 255 / 0.025), transparent)`,
  },
  // flex min-w-0 items-center justify-center overflow-hidden border-r border-white/10
  divFlex: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRightWidth: stroke.hairline,
    borderRightStyle: "solid",
    borderColor: colors.hairline,
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
    backgroundColor: colors.scrimLight,
  },
  // pointer-events-none absolute inset-y-0 z-20 w-px bg-[#E8E044] shadow-[0_0_10px_rgba(232,224,68,0.65)]
  timelinePlayhead: {
    pointerEvents: "none",
    position: "absolute",
    top: "0",
    bottom: "0",
    zIndex: layers.float,
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
    paddingBottom: space.s12,
  },
  // m-3 grid h-24 place-items-center border border-dashed border-white/15 px-4 text-center text-xs text-white/35
  pGridXs: {
    margin: space.s3,
    display: "grid",
    height: "6rem",
    placeItems: "center",
    borderWidth: stroke.hairline,
    borderStyle: "dashed",
    borderColor: colors.hairlineStrong,
    paddingInline: space.s4,
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.inkFaint,
  },
  // grid h-10 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] border-b border-white/10 bg-black/20
  timelineSignalLane: {
    display: "grid",
    height: "2.5rem",
    gridTemplateColumns: "var(--timeline-identity-width) minmax(0,1fr)",
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: colors.scrimLight,
  },
  // flex min-w-0 items-stretch overflow-hidden border-r border-white/10 bg-[#E8E044]/[0.06]
  divFlex3: {
    display: "flex",
    minWidth: 0,
    alignItems: "stretch",
    overflow: "hidden",
    borderRightWidth: stroke.hairline,
    borderRightStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: colors.accentWash,
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
    transitionProperty: { default: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity", [layout.reducedMotion]: "none" },
    transitionTimingFunction: motion.easeSnappy,
    transitionDuration: { default: motion.durStandard, [layout.reducedMotion]: "0s" },
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s2,
    textAlign: "left",
    fontSize: text.sizeTag,
    color: colors.accent,
    backgroundColor: { default: null, ":hover": colors.accentWash },
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
    fontSize: text.sizeTag,
    color: colors.accent,
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
    transitionProperty: { default: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity", [layout.reducedMotion]: "none" },
    transitionTimingFunction: motion.easeSnappy,
    transitionDuration: { default: motion.durStandard, [layout.reducedMotion]: "0s" },
    display: "grid",
    width: space.s6,
    flexShrink: 0,
    placeItems: "center",
    borderLeftWidth: stroke.hairline,
    borderLeftStyle: "solid",
    borderColor: colors.hairline,
    color: { default: colors.inkFaint, ":hover": colors.critical },
    backgroundColor: { default: null, ":hover": colors.criticalWash },
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
    backgroundColor: colors.fillFaint,
  },
  // grid border-b border-white/10
  timelineWorldLane: {
    display: "grid",
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
  },
  // relative z-10 flex min-w-0 items-start overflow-hidden border-r border-white/10 bg-[#E8E044]/[0.04] text-[#E8E044]/80
  timelineWorldIdentity: {
    position: "relative",
    zIndex: layers.raised,
    display: "flex",
    minWidth: 0,
    alignItems: "flex-start",
    overflow: "hidden",
    borderRightWidth: stroke.hairline,
    borderRightStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: colors.accentWash,
    color: colors.accent,
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
    fontSize: text.sizeTag,
    fontWeight: text.weightMedium,
  },
  // grid border-b border-white/10
  timelineActorLane: {
    display: "grid",
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
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
    color: { default: null, ":enabled:hover": colors.ink },
  },
  // whitespace-nowrap text-[9px] font-medium
  spanMedium: {
    whiteSpace: "nowrap",
    fontSize: text.sizeTag,
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
    color: { default: colors.inkFaint, ":hover": colors.critical, ":focus-visible": colors.critical },
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
    color: colors.inkGhost,
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
    fontSize: text.sizeNano,
    color: colors.inkGhost,
  },
  // grid h-10 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] border-b border-white/10 bg-[#E8E044]/[0.025]
  timelineReasoningTraceLane: {
    display: "grid",
    height: "2.5rem",
    gridTemplateColumns: "var(--timeline-identity-width) minmax(0,1fr)",
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
    backgroundColor: colors.accentWash,
  },
  // flex min-w-0 items-center overflow-hidden border-r border-white/10 text-[#E8E044]/80
  divFlex8: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    overflow: "hidden",
    borderRightWidth: stroke.hairline,
    borderRightStyle: "solid",
    borderColor: colors.hairline,
    color: colors.accent,
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
    fontSize: text.sizeNano,
    color: colors.inkGhost,
  },
  // block truncate
  spanTruncate: {
    display: "block",
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
    fontSize: text.sizeMicro,
    fontWeight: text.weightSemibold,
    color: colors.ink,
  },
  // text-[8px] text-white/40
  observationAndAction: {
    fontSize: text.sizeNano,
    color: colors.inkMuted,
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
    color: colors.inkMuted,
  },
  // mt-1 h-8 w-full min-w-0 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] normal-case text-white outline-none focus:border-[#E8E044]/60
  input: {
    marginTop: space.s1,
    height: space.s8,
    width: "100%",
    minWidth: 0,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.hairline, ":focus": colors.accentLine },
    backgroundColor: colors.fillSubtle,
    paddingInline: space.s2,
    fontSize: text.sizeMicro,
    textTransform: "none",
    color: colors.ink,
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // block text-[8px] uppercase tracking-[0.1em] text-white/45
  observation: {
    display: "block",
    color: colors.inkMuted,
  },
  // mt-1 min-h-24 w-full resize-y rounded-md border border-white/10 bg-white/[0.04] p-2 text-[10px] normal-case leading-relaxed text-white outline-none focus:border-[#E8E044]/60
  textarea: {
    marginTop: space.s1,
    minHeight: "6rem",
    width: "100%",
    resize: "vertical",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.hairline, ":focus": colors.accentLine },
    backgroundColor: colors.fillSubtle,
    padding: space.s2,
    fontSize: text.sizeMicro,
    textTransform: "none",
    lineHeight: text.lineRelaxed,
    color: colors.ink,
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // block text-[8px] uppercase tracking-[0.1em] text-white/45
  action: {
    display: "block",
    color: colors.inkMuted,
  },
  // mt-1 min-h-24 w-full resize-y rounded-md border border-white/10 bg-white/[0.04] p-2 text-[10px] normal-case leading-relaxed text-white outline-none focus:border-[#E8E044]/60
  textarea2: {
    marginTop: space.s1,
    minHeight: "6rem",
    width: "100%",
    resize: "vertical",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.hairline, ":focus": colors.accentLine },
    backgroundColor: colors.fillSubtle,
    padding: space.s2,
    fontSize: text.sizeMicro,
    textTransform: "none",
    lineHeight: text.lineRelaxed,
    color: colors.ink,
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // grid grid-cols-1 gap-1.5 border-t border-white/10 pt-3
  divGrid2: {
    display: "grid",
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    gap: space.s1_5,
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderColor: colors.hairline,
    paddingTop: space.s3,
  },
  // h-8 rounded-md bg-[#E8E044] px-3 text-[10px] font-semibold text-black disabled:opacity-40
  saveTraceButton: {
    height: space.s8,
    backgroundColor: colors.accent,
    paddingInline: space.s3,
    fontSize: text.sizeMicro,
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
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.critical,
    fontSize: text.sizeTag,
    color: colors.critical,
    backgroundColor: { default: null, ":hover": colors.criticalWash },
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
    backgroundColor: colors.fill,
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
    fontSize: text.sizeNano,
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
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "color-mix(in srgb, currentColor 20%, transparent)",
    backgroundColor: "rgb(0 0 0 / 0.15)",
    paddingInline: space.s0_5,
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
    backgroundImage: "linear-gradient(150deg,rgba(30,30,27,0.98),rgba(10,10,10,0.98))",
    padding: space.s3,
    color: colors.ink,
    boxShadow: "0 24px 80px rgba(0,0,0,0.72),0 0 0 1px rgba(232,224,68,0.12)",
    backdropFilter: motion.blurLg,
  },
  // mb-3 flex items-start gap-3 border-b border-white/10 pb-2.5
  headerFlex: {
    marginBottom: space.s3,
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
    paddingBottom: space.s2_5,
  },
  // mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-[#E8E044]/30 bg-[#E8E044]/10 text-[#E8E044]
  spanGridIcon: {
    marginTop: space.s0_5,
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: 0,
    placeItems: "center",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.accentWash,
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
    color: colors.accent,
  },
  // mt-0.5 truncate text-xs text-white/60
  pTruncateXs: {
    marginTop: space.s0_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.inkSecondary,
  },
  // grid size-7 place-items-center rounded-lg text-lg leading-none text-white/45 hover:bg-white/10 hover:text-white
  closeActionMenuButton: {
    display: "grid",
    width: "1.75rem",
    height: "1.75rem",
    placeItems: "center",
    fontSize: text.sizeLg,
    lineHeight: "1",
    color: { default: colors.inkMuted, ":hover": colors.ink },
    backgroundColor: { default: null, ":hover": colors.fillStrong },
  },
  // grid gap-2 sm:grid-cols-2
  divGrid3: {
    display: "grid",
    gap: space.s2,
    gridTemplateColumns: { default: null, [layout.bpSm]: "repeat(2, minmax(0, 1fr))" },
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
  // sm:col-span-2
  div3: {
    gridColumn: { default: null, [layout.bpSm]: "span 2 / span 2" },
  },
  // rounded-xl border border-white/10 bg-white/[0.035] p-2
  timelineContextGroup: {
    backgroundColor: colors.fillSubtle,
    padding: space.s2,
  },
  // mb-1.5 px-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/40
  h3SemiboldUppercase: {
    marginBottom: space.s1_5,
    paddingInline: space.s1,
    color: colors.inkMuted,
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
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: { default: "transparent", ":hover": colors.accentLineSubtle },
    backgroundColor: { default: colors.scrimLight, ":hover": colors.accentWash },
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    textAlign: "left",
    fontSize: text.sizeMicro,
    lineHeight: text.lineTight,
    color: { default: colors.inkSecondary, ":hover": colors.accent },
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
