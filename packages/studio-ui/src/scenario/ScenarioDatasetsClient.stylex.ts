import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  // relative h-full min-h-0 overflow-hidden bg-background text-foreground
  scenarioDatasetIndex: {
    position: "relative",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: colors.bg,
    color: colors.text,
  },
  // pointer-events-auto h-full
  resizablepanel: {
    pointerEvents: "auto",
    height: "100%",
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
    flex: "1 1 0%",
  },
  /** Cross-fade surface between the coverage map and the 3D world. */
  transitionCover: {
    position: "absolute",
    inset: "0",
    zIndex: 30,
    pointerEvents: "none",
    transitionProperty: "opacity",
    transitionDuration: "300ms",
    transitionTimingFunction: "ease-out",
  },
  transitionCoverVisible: {
    opacity: 1,
  },
  transitionCoverHidden: {
    opacity: 0,
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
