import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  editorShell: { position: "relative", height: "100%", minWidth: 0, minHeight: 0, color: colors.text, pointerEvents: "auto", backgroundColor: colors.bg },
  externalShell: { pointerEvents: "none", backgroundColor: "transparent" },
  // grid h-32 place-items-center text-xs text-muted-foreground
  divGridXs: {
    display: "grid",
    height: "8rem",
    placeItems: "center",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
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
    backgroundColor: colors.scrimHeavy,
    paddingInline: space.s3,
    paddingBlock: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.ink,
    boxShadow: shadows.elevationLg,
    backdropFilter: motion.blurGlass,
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
    lineHeight: text.lineXs,
    color: colors.ink,
  },
  // pointer-events-none absolute inset-x-10 -bottom-5 h-16 rounded-full bg-black/45 blur-2xl
  divAbsolute: {
    pointerEvents: "none",
    position: "absolute",
    left: "2.5rem",
    right: "2.5rem",
    bottom: "-1.25rem",
    height: "4rem",
    backgroundColor: colors.scrim,
    filter: motion.blurLg,
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
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.warning,
    backgroundColor: colors.scrimHeavy,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    textAlign: "center",
    fontSize: text.sizeMeta,
    fontWeight: text.weightMedium,
    lineHeight: text.lineSnug,
    color: colors.warning,
    boxShadow: shadows.elevationLg,
    backdropFilter: motion.blurGlass,
  },
  // absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-amber-300/80 bg-black
  spanAbsoluteIcon: {
    position: "absolute",
    left: "50%",
    top: "100%",
    width: space.s2,
    height: space.s2,
    transform: "rotate(45deg)",
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderRightWidth: stroke.hairline,
    borderRightStyle: "solid",
    borderColor: colors.warning,
    backgroundColor: "rgb(0 0 0 / 1)",
  },
});
