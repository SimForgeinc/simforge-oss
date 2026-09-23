import * as stylex from "@stylexjs/stylex";

import { layout, space } from "../../stylex/tokens.stylex";

/**
 * Layout only. The banner's look is `surface.raised` + `hairline.all`, its
 * status is the warning `Dot`, and its text is the `typography` recipes.
 */
export const styles = stylex.create({
  /** Sits in the status layer, which ignores the pointer; the banner takes it back. */
  banner: {
    pointerEvents: "auto",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    gap: space.s3,
    maxWidth: layout.formMeasure,
    marginTop: space.s3,
    marginInline: space.s3,
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
  text: { display: "grid", gap: space.s1, minWidth: 0 },
  heading: { margin: 0 },
  body: { margin: 0 },
  actions: { display: "flex", alignItems: "center", gap: space.s2 },
  roleList: {
    display: "grid",
    gap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
});
