import * as stylex from "@stylexjs/stylex";
import { colors, text, space, layers } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  editorShell: { position: "relative", height: "100%", minWidth: 0, minHeight: 0, color: colors.text, pointerEvents: "auto", backgroundColor: colors.bg },
  externalShell: { pointerEvents: "none", backgroundColor: "transparent" },
  // grid h-32 place-items-center text-xs text-muted-foreground
  gridCenteredXs: {
    display: "grid",
    height: "8rem",
    placeItems: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // pointer-events-auto
  live: {
    pointerEvents: "auto",
  },
  // pointer-events-none flex flex-col items-center gap-2
  flexColCenter: {
    pointerEvents: "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s2,
  },
  // pointer-events-none rounded-md border border-border/70 bg-black/85 px-3 py-1 text-xs text-white shadow-lg backdrop-blur-md
  xsWhiteBordered: {
    pointerEvents: "none",
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "rgb(0 0 0 / 0.85)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s1,
    paddingBottom: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 1)",
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(12px)",
  },
  // pointer-events-none absolute inset-x-0 bottom-0 flex h-auto max-h-[min(65vh,520px)] justify-center px-4
  absFlexMid: {
    pointerEvents: "none",
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    display: "flex",
    height: "auto",
    maxHeight: "min(65vh, 520px)",
    justifyContent: "center",
    paddingLeft: space.s4,
    paddingRight: space.s4,
  },
  // pointer-events-auto relative h-auto max-h-[min(65vh,520px)] w-full max-w-[920px] min-w-0
  relLiveWide: {
    pointerEvents: "auto",
    position: "relative",
    height: "auto",
    maxHeight: "min(65vh, 520px)",
    width: "100%",
    minWidth: "0px",
    maxWidth: "920px",
  },
  // pointer-events-none absolute inset-x-0 -top-6 text-center text-xs text-white
  absXsWhite: {
    pointerEvents: "none",
    position: "absolute",
    left: 0,
    right: 0,
    top: "-1.5rem",
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 1)",
  },
  // pointer-events-none absolute inset-x-10 -bottom-5 h-16 rounded-full bg-black/45 blur-2xl
  absInertRound: {
    pointerEvents: "none",
    position: "absolute",
    left: "2.5rem",
    right: "2.5rem",
    bottom: "-1.25rem",
    height: "4rem",
    borderRadius: "0",
    backgroundColor: colors.scrim,
    filter: "blur(40px)",
  },
  // pointer-events-none fixed z-[90] max-w-56 -translate-x-1/2 -translate-y-full pb-3
  fixedInert: {
    pointerEvents: "none",
    position: "fixed",
    zIndex: layers.editorTop,
    maxWidth: "14rem",
    transform: "translate(-50%, -100%)",
    paddingBottom: space.s3,
  },
  // relative border border-amber-300/80 bg-black/90 px-3 py-2 text-center text-[11px] font-medium leading-snug text-amber-100 shadow-lg backdrop-blur-md
  relMediumBordered: {
    position: "relative",
    borderWidth: "1px",
    borderColor: "rgb(252 211 77 / 0.8)",
    backgroundColor: "rgb(0 0 0 / 0.9)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    paddingTop: space.s2,
    paddingBottom: space.s2,
    textAlign: "center",
    fontSize: "11px",
    fontWeight: text.weightMedium,
    lineHeight: "1.375",
    color: "rgb(254 243 199 / 1)",
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(12px)",
  },
  // absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-amber-300/80 bg-black
  absRuleBRuleR: {
    position: "absolute",
    left: "50%",
    top: "100%",
    width: "0.5rem",
    height: "0.5rem",
    transform: "translate(-50%, -50%) rotate(45deg)",
    borderBottomWidth: "1px",
    borderRightWidth: "1px",
    borderColor: "rgb(252 211 77 / 0.8)",
    backgroundColor: "rgb(0 0 0 / 1)",
  },
  // h-full min-h-editor-shell text-foreground
  inkTall: {
    height: "100%",
    minHeight: space.shellWidth,
    color: colors.text,
  },
  // pointer-events-none
  inert: {
    pointerEvents: "none",
  },
  // bg-transparent
  bgTransparent: {
    backgroundColor: "transparent",
  },
  // bg-background
  bgBackground: {
    backgroundColor: colors.bg,
  },
  // flex h-full
  flexTall: {
    display: "flex",
    height: "100%",
  },
  // flex
  flex: {
    display: "flex",
  },
  // grid h-32 place-items-center text-xs text-muted-foreground
  divGridXs: {
    display: "grid",
    height: "8rem",
    placeItems: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // pointer-events-auto
  div: {
    pointerEvents: "auto",
  },
  // pointer-events-none flex flex-col items-center gap-2
  divFlex: {
    pointerEvents: "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s2,
  },
  // pointer-events-none rounded-md border border-border/70 bg-black/85 px-3 py-1 text-xs text-white shadow-lg backdrop-blur-md
  clipboardNotice: {
    pointerEvents: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "rgb(0 0 0 / 0.85)",
    paddingInline: space.s3,
    paddingBlock: space.s1,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 1)",
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(12px)",
  },
  // pointer-events-none absolute inset-x-0 bottom-0 flex h-auto max-h-[min(65vh,520px)] justify-center px-4
  floatingTimelineLayer: {
    pointerEvents: "none",
    position: "absolute",
    left: "0",
    right: "0",
    bottom: "0",
    display: "flex",
    height: "auto",
    maxHeight: "min(65vh,520px)",
    justifyContent: "center",
    paddingInline: space.s4,
  },
  // pointer-events-auto relative h-auto max-h-[min(65vh,520px)] w-full max-w-[920px] min-w-0
  divRelative: {
    pointerEvents: "auto",
    position: "relative",
    height: "auto",
    maxHeight: "min(65vh,520px)",
    width: "100%",
    maxWidth: "920px",
    minWidth: 0,
  },
  // pointer-events-none absolute inset-x-0 -top-6 text-center text-xs text-white
  pressEscapeToExitSimulation: {
    pointerEvents: "none",
    position: "absolute",
    left: "0",
    right: "0",
    top: `calc(-1 * ${space.s6})`,
    textAlign: "center",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(255 255 255 / 1)",
  },
  // pointer-events-none absolute inset-x-10 -bottom-5 h-16 rounded-full bg-black/45 blur-2xl
  divAbsolute: {
    pointerEvents: "none",
    position: "absolute",
    left: "2.5rem",
    right: "2.5rem",
    bottom: "-1.25rem",
    height: "4rem",
    backgroundColor: "rgb(0 0 0 / 0.45)",
    filter: "blur(40px)",
  },
  // pointer-events-none fixed z-[90] max-w-56 -translate-x-1/2 -translate-y-full pb-3
  routePointSpeedWarning: {
    pointerEvents: "none",
    position: "fixed",
    zIndex: layers.editorTop,
    maxWidth: "14rem",
    transform: "translateY(-100%)",
    paddingBottom: space.s3,
  },
  // relative border border-amber-300/80 bg-black/90 px-3 py-2 text-center text-[11px] font-medium leading-snug text-amber-100 shadow-lg backdrop-blur-md
  divRelativeMedium: {
    position: "relative",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgb(252 211 77 / 0.8)",
    backgroundColor: "rgb(0 0 0 / 0.9)",
    paddingInline: space.s3,
    paddingBlock: space.s2,
    textAlign: "center",
    fontSize: "11px",
    fontWeight: text.weightMedium,
    lineHeight: "1.375",
    color: "rgb(254 243 199 / 1)",
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(12px)",
  },
  // absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-amber-300/80 bg-black
  spanAbsoluteIcon: {
    position: "absolute",
    left: "50%",
    top: "100%",
    width: space.s2,
    height: space.s2,
    transform: "rotate(45deg)",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderRightWidth: "1px",
    borderRightStyle: "solid",
    borderColor: "rgb(252 211 77 / 0.8)",
    backgroundColor: "rgb(0 0 0 / 1)",
  },
});
