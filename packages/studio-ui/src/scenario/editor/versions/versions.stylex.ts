import * as stylex from "@stylexjs/stylex";

import { layout, space } from "../../../stylex/tokens.stylex";

/**
 * Layout only, for the Versions family (panel, banners, compare). Every look comes from recipes
 * and primitives in the components.
 */
export const styles = stylex.create({
  sheet: { display: "flex", flexDirection: "column", overflow: "hidden" },
  header: { display: "grid", gap: space.s2, paddingInline: space.s4, paddingBlock: space.s4 },
  saveRow: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: space.s2, alignItems: "center" },
  body: { flex: "1 1 auto", minHeight: 0, overflowY: "auto" },
  state: { display: "grid", justifyItems: "start", gap: space.s2, paddingInline: space.s4, paddingBlock: space.s4 },
  list: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
  version: { display: "grid", gap: space.s2, paddingInline: space.s4, paddingBlock: space.s3 },
  versionHead: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: space.s2, alignItems: "start" },
  versionText: { display: "grid", gap: space.s0_5, minWidth: 0 },
  versionTitleRow: { display: "flex", alignItems: "center", gap: space.s2, minWidth: 0 },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s1_5 },
  simulations: { display: "grid", gap: space.s1, margin: 0, padding: 0, listStyle: "none", paddingInlineStart: space.s3 },
  simulation: { display: "grid", gap: space.s1, paddingInline: space.s2, paddingBlock: space.s2 },
  simulationHead: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s1_5, minWidth: 0 },
  details: { display: "grid", gap: space.s0_5 },
  detailsList: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: space.s2,
    rowGap: space.s0_5,
    margin: 0,
    paddingBlockStart: space.s1,
  },
  detailsValue: { margin: 0, minWidth: 0 },
  /** Banners sit in the status layer, which ignores the pointer; a banner takes it back. */
  banner: {
    pointerEvents: "auto",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "center",
    gap: space.s3,
    maxWidth: layout.formMeasure,
    marginTop: space.s3,
    marginInline: space.s3,
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
  bannerText: { display: "grid", gap: space.s1, minWidth: 0 },
  bannerHeading: { margin: 0 },
  bannerBody: { margin: 0 },
  bannerActions: { gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  compareBody: { display: "grid", gap: space.s3 },
  compareStage: { width: "100%", aspectRatio: "16 / 10", minHeight: 0 },
  compareControls: { display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", alignItems: "center", gap: space.s2 },
  compareScrubber: { width: "100%" },
  compareLegend: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s3 },
  compareTable: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", columnGap: space.s3, rowGap: space.s0_5, margin: 0 },
  compareCell: { margin: 0, minWidth: 0 },
});
