import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  /** The page itself never scrolls: the rail and the stage each own their overflow. */
  root: {
    position: "relative",
    display: "flex",
    flexDirection: "row",
    height: "100%",
    minHeight: 0,
    width: "100%",
    overflow: "hidden",
    backgroundColor: colors.bg,
    color: colors.text,
  },
  panel: {
    pointerEvents: "auto",
    height: "100%",
  },
  /** Section strip at its fixed width; the rail takes the rest of the panel. */
  panelGrid: {
    display: "grid",
    gridTemplateColumns: `${space.datasetStripWidth} minmax(0, 1fr)`,
    height: "100%",
    minHeight: 0,
    width: "100%",
  },
  railColumn: {
    display: "flex",
    minWidth: 0,
    minHeight: 0,
    height: "100%",
    flexDirection: "column",
    overflow: "hidden",
  },
  /** Holds the overlay still while the stage beneath it scrolls. */
  stageWrap: {
    position: "relative",
    flex: "1 1 0%",
    minWidth: 0,
    minHeight: 0,
    height: "100%",
    overflow: "hidden",
  },
  stage: {
    height: "100%",
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
  },
  /**
   * Errors float over the stage rather than sitting in the rail, for the same
   * reason the datasets index floats them: a failed action belongs next to
   * nothing in particular, and the rail is too narrow for a message and a retry.
   */
  overlay: {
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
});
