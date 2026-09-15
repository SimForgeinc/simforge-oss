import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex flex-col items-center gap-1 text-center
  divFlex: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.xs,
    textAlign: "center",
  },
  // size-9 text-[#E8E044]
  gamepad2Icon: {
    width: "2.25rem",
    height: "2.25rem",
    color: colors.accent,
  },
  // text-xs font-medium text-white
  manualDrive: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: "rgb(255 255 255 / 1)",
  },
  // text-[9px] uppercase tracking-[0.16em] text-white/40
  manualDriveStatus: {
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: "0.16em",
    color: "rgb(255 255 255 / 0.4)",
  },
  // space-y-3
  manualDriveDetails: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  // text-[10px] leading-4 text-white/55
  p: {
    fontSize: "10px",
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.55)",
  },
  // text-[10px] leading-4 text-amber-200
  manualDriveClipMismatch: {
    fontSize: "10px",
    lineHeight: "1rem",
    color: "rgb(254 240 138 / 1)",
  },
  // text-[10px] leading-4 text-white/45
  ownsThisActorRsquo: {
    fontSize: "10px",
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.45)",
  },
  // space-y-2
  manualDriveWaiting: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  // text-[10px] leading-4 text-[#E8E044]
  recorderOpenInAnotherTabFini: {
    fontSize: "10px",
    lineHeight: "1rem",
    color: colors.accent,
  },
  // editor-motion flex h-8 w-full items-center justify-center rounded-lg border border-white/15 px-3 text-[10px] font-semibold text-white/70 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  manualDriveStopWaitingButton: {
    transitionProperty: { default: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity", "@media (prefers-reduced-motion: reduce)": "none" },
    transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    transitionDuration: { default: "150ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    display: "flex",
    height: space.xxxl,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.15)",
    paddingInline: space.lg,
    fontSize: "10px",
    fontWeight: text.weightSemibold,
    color: "rgb(255 255 255 / 0.7)",
    backgroundColor: { default: null, ":hover": "rgb(255 255 255 / 0.1)" },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.accent}` },
  },
  // editor-motion flex h-10 w-full items-center justify-center rounded-lg border border-[#E8E044] bg-[#E8E044] px-3 text-xs font-semibold text-black hover:bg-[#f4ed5d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40
  manualDriveRecordButton: {
    transitionProperty: { default: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity", "@media (prefers-reduced-motion: reduce)": "none" },
    transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    transitionDuration: { default: "150ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    display: "flex",
    height: "2.5rem",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.accent,
    backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    paddingInline: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightSemibold,
    color: "rgb(0 0 0 / 1)",
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    cursor: { default: null, ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.4 },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px rgb(255 255 255 / 1)` },
  },
  // text-[10px] leading-4 text-white/45
  recordingAgainReplacesThisTa: {
    fontSize: "10px",
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 0.45)",
  },
  // text-[10px] leading-4 text-amber-200
  manualDriveRecordFailure: {
    fontSize: "10px",
    lineHeight: "1rem",
    color: "rgb(254 240 138 / 1)",
  },
});
