import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  errorCover: { position: "absolute", inset: 0, zIndex: 30 },
  worldSurface: { position: "absolute", inset: 0, zIndex: 0 },
  listSession: { position: "relative", zIndex: 10, display: "flex", height: "100%", minHeight: 0, minWidth: 0, width: "100%" },
  hiddenSession: { visibility: "hidden", pointerEvents: "none" },
  coverageSurface: { pointerEvents: "auto", position: "absolute", inset: 0, transitionProperty: "transform, filter", transitionDuration: { default: "420ms", "@media (prefers-reduced-motion: reduce)": "0ms" } },
  coverageBlurred: { transform: "scale(1.02)", filter: "blur(14px)" },
  editorSession: { pointerEvents: "none", position: "absolute", inset: 0, zIndex: 20, visibility: "visible", opacity: 1 },
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
    paddingInline: space.lg,
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
    left: space.xl,
    right: space.xl,
    top: space.xl,
    display: "flex",
    alignItems: "center",
    gap: space.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--card) / 0.95)",
    padding: space.md,
    boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
    backdropFilter: "blur(8px)",
  },
  // min-w-0 flex-1
  copyableerrormessage: {
    minWidth: 0,
    flex: "1 1 0%",
  },
});
