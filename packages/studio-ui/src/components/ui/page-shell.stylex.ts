import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  /** The full height of the dashboard's main area, clipped. */
  stage: {
    position: "relative",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    color: colors.ink,
  },
  frame: {
    position: "relative",
    zIndex: layers.raised,
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr)",
    height: "100%",
    minHeight: 0,
    width: "100%",
    maxWidth: layout.utilityFrame,
    marginInline: "auto",
    padding: { default: layout.gutterNarrow, [layout.bpSm]: layout.gutter, [layout.bpLg]: layout.gutterWide },
  },
  description: {
    marginTop: space.s1,
    fontSize: text.sizeSm,
    lineHeight: text.lineNormal,
    color: colors.inkMuted,
  },
  /**
   * The one scroller. `overscrollBehavior: contain` keeps a flicked pane from
   * handing the gesture to whatever is behind the stage.
   */
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignContent: "start",
    gap: space.s3,
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  bodyFill: {
    gridTemplateRows: "minmax(0, 1fr)",
    alignContent: "stretch",
    overflowY: "hidden",
  },
});
