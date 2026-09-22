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
    minWidth: 0,
    width: "100%",
    overflow: "hidden",
    backgroundColor: colors.bg,
    color: colors.text,
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
  /** Error actions remain reachable without covering the stage's controls. */
  stageWrap: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flex: "1 1 0%",
    minWidth: 0,
    minHeight: 0,
    height: "100%",
    overflow: "hidden",
  },
  stage: {
    flex: "1 1 0%",
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
  },
  overlay: {
    flex: "0 1 auto",
    maxHeight: "40%",
    overflowY: "auto",
    minWidth: 0,
    padding: space.md,
  },
});
