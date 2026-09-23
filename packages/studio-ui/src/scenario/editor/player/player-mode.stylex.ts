import * as stylex from "@stylexjs/stylex";

/**
 * How editor chrome steps aside while the simulation player owns the viewport.
 *
 * Hidden, not unmounted: every panel keeps its React state, its scroll
 * position and its measured size, so leaving the player puts it back exactly
 * as it was. `visibility` rather than `display` because a `display: none`
 * subtree measures zero, and the timeline dock and the catalog both persist
 * sizes from their measurements; a hidden box keeps its geometry. A hidden
 * element also cannot be clicked or focused.
 */
export const playerChrome = stylex.create({
  hidden: {
    visibility: "hidden",
    pointerEvents: "none",
  },
  /**
   * The same, for a wrapper that must not take part in layout (a slot whose
   * children position themselves). `visibility` is inherited, so it reaches
   * fixed-position descendants through the contents box.
   */
  hiddenContents: {
    display: "contents",
    visibility: "hidden",
  },
});
