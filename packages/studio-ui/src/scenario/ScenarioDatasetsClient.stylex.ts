import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, motion, shadows, space, stroke } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  errorCover: { position: "absolute", inset: 0, zIndex: layers.sticky },
  worldSurface: { position: "absolute", inset: 0, zIndex: 0 },
  listSession: { position: "relative", zIndex: layers.raised, display: "flex", height: "100%", minHeight: 0, minWidth: 0, width: "100%" },
  hiddenSession: { visibility: "hidden", pointerEvents: "none" },
  coverageSurface: { pointerEvents: "auto", position: "absolute", inset: 0, transitionProperty: "transform, filter", transitionDuration: { default: "420ms", [layout.reducedMotion]: "0ms" } },
  coverageBlurred: { transform: "scale(1.02)", filter: "blur(14px)" },
  editorSession: { pointerEvents: "none", position: "absolute", inset: 0, zIndex: layers.float, visibility: "visible", opacity: 1 },
  // relative h-full min-h-0 overflow-hidden bg-background text-foreground
  scenarioDatasetIndex: {
    position: "relative",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: colors.bg,
    color: colors.text,
  },
  /** Dataset strip on the left at its fixed width; the scenario column takes the rest. */
  panelGrid: {
    display: "grid",
    gridTemplateColumns: `${space.datasetStripWidth} minmax(0, 1fr)`,
    height: "100%",
    minHeight: 0,
    width: "100%",
  },
  emptyColumn: {
    height: "100%",
    borderStyle: "none",
    backgroundColor: "transparent",
    paddingInline: space.s3,
  },
  // pointer-events-none relative min-w-0 flex-1
  divRelative: {
    pointerEvents: "none",
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    height: "100%",
    flex: "1 1 0%",
  },
  // pointer-events-auto
  div: {
    pointerEvents: "auto",
  },
  // pointer-events-auto absolute inset-x-4 top-4 flex items-center gap-2 border border-border bg-card/95 p-2 shadow-xl backdrop-blur
  divAbsoluteFlex: {
    pointerEvents: "auto",
    position: "absolute",
    left: space.s4,
    right: space.s4,
    top: space.s4,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.95)",
    padding: space.s2,
    boxShadow: shadows.elevationXl,
    backdropFilter: motion.blurMd,
  },
  // min-w-0 flex-1
  copyableerrormessage: {
    minWidth: 0,
    flex: "1 1 0%",
  },
});
