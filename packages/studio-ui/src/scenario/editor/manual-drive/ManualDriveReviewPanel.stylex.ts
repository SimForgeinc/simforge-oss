import * as stylex from "@stylexjs/stylex";
import { colors, layers, space, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-auto fixed inset-0 z-[150] flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm
  manualDriveReviewBackdrop: {
    pointerEvents: "auto",
    position: "fixed",
    inset: "0",
    zIndex: layers.tutorialTop,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgb(0 0 0 / 0.55)",
    paddingInline: space.xl,
    backdropFilter: "blur(4px)",
  },
  // w-full max-w-md border border-white/15 bg-[#111111]/95 p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,0.7)] focus:outline-none
  manualDriveReview: {
    width: "100%",
    maxWidth: "28rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.15)",
    backgroundColor: "rgb(17 17 17 / 0.95)",
    padding: "1.25rem",
    color: "rgb(255 255 255 / 1)",
    boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
    outline: { default: null, ":focus": "2px solid transparent" },
    outlineOffset: { default: null, ":focus": "2px" },
  },
  // flex items-start gap-3
  divFlex: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.lg,
  },
  // flex size-10 shrink-0 items-center justify-center bg-[#E8E044] text-black
  spanFlexIcon: {
    display: "flex",
    width: "2.5rem",
    height: "2.5rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    color: "rgb(0 0 0 / 1)",
  },
  // size-5
  routeIcon: {
    width: "1.25rem",
    height: "1.25rem",
  },
  // min-w-0 flex-1
  div: {
    minWidth: 0,
    flex: "1 1 0%",
  },
  // font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]
  manualDrive: {
    fontFamily: text.fontMono,
    fontSize: "10px",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: "0.18em",
    color: colors.accent,
  },
  // mt-1 text-lg font-semibold
  manualDriveReviewTitle: {
    marginTop: space.xs,
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
  },
  // flex size-8 shrink-0 items-center justify-center text-white/55 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  discardTakeButton: {
    display: "flex",
    width: space.xxxl,
    height: space.xxxl,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    color: { default: "rgb(255 255 255 / 0.55)", ":hover": "rgb(255 255 255 / 1)" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.accent}` },
  },
  // size-4
  xIcon: {
    width: space.xl,
    height: space.xl,
  },
  // mt-5 space-y-3
  manualDriveReviewDescription: {
    marginTop: "1.25rem",
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  // grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-center
  dlGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.md,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.lg,
    textAlign: "center",
  },
  // flex items-center justify-center gap-1 text-[9px] uppercase tracking-[0.14em] text-white/40
  dtFlexUppercase: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    color: "rgb(255 255 255 / 0.4)",
  },
  // size-3
  clipTimer: {
    width: space.lg,
    height: space.lg,
  },
  // mt-1 text-sm font-semibold
  manualDriveReviewClip: {
    marginTop: space.xs,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // flex items-center justify-center gap-1 text-[9px] uppercase tracking-[0.14em] text-white/40
  dtFlexUppercase2: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    color: "rgb(255 255 255 / 0.4)",
  },
  // size-3
  drivenRoute: {
    width: space.lg,
    height: space.lg,
  },
  // mt-1 text-sm font-semibold
  manualDriveReviewDistance: {
    marginTop: space.xs,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // flex items-center justify-center gap-1 text-[9px] uppercase tracking-[0.14em] text-white/40
  dtFlexUppercase3: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    color: "rgb(255 255 255 / 0.4)",
  },
  // size-3
  peakGauge: {
    width: space.lg,
    height: space.lg,
  },
  // mt-1 text-sm font-semibold
  manualDriveReviewSpeed: {
    marginTop: space.xs,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // border-t border-white/10 pt-3 text-sm leading-6 text-white/75
  manualDriveReviewSamples: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.lg,
    fontSize: text.sizeSm,
    lineHeight: "1.5rem",
    color: "rgb(255 255 255 / 0.75)",
  },
  // mt-1 size-4 shrink-0
  alerttriangleIcon: {
    marginTop: space.xs,
    width: space.xl,
    height: space.xl,
    flexShrink: 0,
  },
  // border-t border-white/10 pt-3 text-sm leading-6 text-white/75
  manualDriveReviewReplacement: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.lg,
    fontSize: text.sizeSm,
    lineHeight: "1.5rem",
    color: "rgb(255 255 255 / 0.75)",
  },
  // mt-1
  it: {
    marginTop: space.xs,
  },
  // font-semibold text-white
  strongSemibold: {
    fontWeight: text.weightSemibold,
    color: "rgb(255 255 255 / 1)",
  },
  // mt-1 text-white/55
  lights: {
    marginTop: space.xs,
    color: "rgb(255 255 255 / 0.55)",
  },
  // text-sm leading-6 text-amber-200
  manualDriveReviewFailure: {
    fontSize: text.sizeSm,
    lineHeight: "1.5rem",
    color: "rgb(254 240 138 / 1)",
  },
  // mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-4
  divFlex2: {
    marginTop: "1.25rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space.md,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingTop: space.xl,
  },
  // h-10 px-4 text-xs font-semibold uppercase tracking-[0.12em] text-white/70 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  manualDriveReviewDiscardButton: {
    height: "2.5rem",
    paddingInline: space.xl,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    color: { default: "rgb(255 255 255 / 0.7)", ":hover": "rgb(255 255 255 / 1)" },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.accent}` },
  },
  // h-10 border border-[#E8E044]/50 px-4 text-xs font-semibold uppercase tracking-[0.12em] text-[#E8E044] transition-colors hover:bg-[#E8E044]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  manualDriveReviewRerecordButton: {
    height: "2.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgb(232 224 68 / 0.5)",
    paddingInline: space.xl,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    color: colors.accent,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    backgroundColor: { default: null, ":hover": "rgb(232 224 68 / 0.1)" },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.accent}` },
  },
  // h-10 bg-[#E8E044] px-5 text-xs font-bold uppercase tracking-[0.12em] text-black transition-colors hover:bg-[#f4ed55] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40
  manualDriveReviewSaveButton: {
    height: "2.5rem",
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    paddingInline: "1.25rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    color: "rgb(0 0 0 / 1)",
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    cursor: { default: null, ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.4 },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px rgb(255 255 255 / 1)` },
  },
});
