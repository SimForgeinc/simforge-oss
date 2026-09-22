/**
 * TEMPLATE: copy this file with `TemplatePanel.tsx` to start a component.
 *
 * A component's own style module holds layout only: how its parts are
 * arranged, sized and spaced. Every look (colour, type, borders, focus,
 * motion) comes from recipes and primitives, composed in the `.tsx`. Every
 * value is a token; there is not one literal colour, size, duration or
 * breakpoint in this file, and yours should not have one either
 * (`pnpm style:ratchet --check` enforces it for new files).
 *
 * Keys are named for the part they style (`header`, `row`), with a state
 * suffix for a state (`rowSelected`), never for their declarations.
 */
import * as stylex from "@stylexjs/stylex";

import { layout, space } from "../../stylex/tokens.stylex";

/**
 * The marker a row publishes so its children can react to the row's hover
 * (`stylex.when.ancestor`), instead of a Tailwind `group-hover`.
 */
export const rowMarker = stylex.defineMarker();

export const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    minWidth: 0,
    minHeight: 0,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
  headerText: { display: "grid", gap: space.s1, minWidth: 0 },
  list: {
    display: "grid",
    alignContent: "start",
    margin: 0,
    padding: 0,
    listStyle: "none",
    overflowY: "auto",
  },
  /** A list item: the row's button, then its action beside it. */
  item: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    paddingInlineEnd: space.s2,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    gap: space.s3,
    width: "100%",
    paddingInline: { default: space.s3, [layout.bpSm]: space.s4 },
    paddingBlock: space.s2_5,
    textAlign: "start",
  },
  rowText: { display: "grid", gap: space.s0_5, minWidth: 0 },
  /**
   * The row action stays hidden until its item is hovered or it holds focus.
   * The wrapper takes the state, because a primitive's own look (`opacity`
   * included) is not the caller's to set through `xstyle`.
   */
  rowAction: {
    display: "inline-flex",
    opacity: { default: 0, [stylex.when.ancestor(":hover", rowMarker)]: 1, ":focus-within": 1 },
  },
});
