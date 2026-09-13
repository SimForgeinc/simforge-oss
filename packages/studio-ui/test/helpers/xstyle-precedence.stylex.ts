import * as stylex from "@stylexjs/stylex";

/**
 * Caller styles for the `xstyle` precedence test: each property here is also
 * declared by the primitive it is handed to, so the merge has something to
 * resolve.
 */
export const callerStyles = stylex.create({
  // Conflicts with `buttonSizes.default` height and `button.base` fontSize.
  button: {
    height: "1.5rem",
    fontSize: "0.75rem",
  },
  // Conflicts with `input.base` fontSize and backgroundColor.
  input: {
    fontSize: "0.75rem",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  // Conflicts with the tabs list's own `display: inline-flex`.
  tabsList: {
    display: "grid",
  },
  // Conflicts with the select-menu trigger's own height and fontSize.
  selectMenu: {
    height: "2rem",
    fontSize: "0.75rem",
  },
  // Conflicts with the switch root's own track width and height.
  switchRoot: {
    width: "3rem",
    height: "1.5rem",
  },
  // Conflicts with `separator.horizontal`'s own hairline height.
  separator: {
    height: "4px",
  },
  // Conflicts with the table's own fontSize.
  table: {
    fontSize: "0.75rem",
  },
  // Conflicts with the card's own plate colour.
  card: {
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  // Conflicts with the sheet panel's own plate colour.
  sheetContent: {
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  // Conflicts with the tooltip panel's own fill and font size.
  tooltipContent: {
    backgroundColor: "rgba(255,255,255,0.05)",
    fontSize: "0.75rem",
  },
  // Conflicts with `badgeVariants.default`, which declares backgroundColor at
  // both the default and the `:hover` condition. A status tone like this pins
  // the rest state only, and must still cancel the variant's hover fill.
  badgeTone: {
    backgroundColor: "rgba(107,114,128,0.15)",
  },
});
