import * as stylex from "@stylexjs/stylex";

import { colors, space, stroke } from "../../../stylex/tokens.stylex";

/** Layout of the before/after view. */
export const styles = stylex.create({
  body: { display: "grid", gap: space.s3 },
  panes: { display: "grid", gridTemplateColumns: { default: "minmax(0, 1fr)", "@media (min-width: 900px)": "minmax(0, 1fr) minmax(0, 1fr)" }, gap: space.s3 },
  pane: { display: "grid", gap: space.s1, minWidth: 0 },
  stage: { width: "100%", aspectRatio: "4 / 3" },
  summary: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  legend: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s3 },
  placements: { display: "grid", gap: space.s1, margin: 0, padding: 0, listStyle: "none", maxHeight: "12rem", overflowY: "auto" },
  placement: { display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", alignItems: "center", gap: space.s2 },
  text: { margin: 0 },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: space.s2 },
});

/** The stage artwork: unchanged roads faint, changed roads by kind of change, actors by placement status. */
export const art = stylex.create({
  road: { fill: "none", stroke: colors.inkGhost, strokeWidth: stroke.hairline, vectorEffect: "non-scaling-stroke" },
  roadElevation: { fill: "none", stroke: colors.info, strokeWidth: stroke.thick, vectorEffect: "non-scaling-stroke" },
  roadGeometry: { fill: "none", stroke: colors.warning, strokeWidth: stroke.thick, vectorEffect: "non-scaling-stroke" },
  roadRemoved: { fill: "none", stroke: colors.critical, strokeWidth: stroke.thick, strokeDasharray: "4 3", vectorEffect: "non-scaling-stroke" },
  actorKept: { fill: colors.ink },
  actorMoved: { fill: colors.accent },
  actorFlagged: { fill: colors.critical },
  actorHeading: { stroke: colors.ink, strokeWidth: stroke.hairline, vectorEffect: "non-scaling-stroke" },
  unplaced: { fill: "none", stroke: colors.critical, strokeWidth: stroke.thick, vectorEffect: "non-scaling-stroke" },
  swatchElevation: { display: "inline-block", width: space.s4, borderTopWidth: stroke.thick, borderTopStyle: "solid", borderTopColor: colors.info },
  swatchGeometry: { display: "inline-block", width: space.s4, borderTopWidth: stroke.thick, borderTopStyle: "solid", borderTopColor: colors.warning },
  swatchRemoved: { display: "inline-block", width: space.s4, borderTopWidth: stroke.thick, borderTopStyle: "dashed", borderTopColor: colors.critical },
});
