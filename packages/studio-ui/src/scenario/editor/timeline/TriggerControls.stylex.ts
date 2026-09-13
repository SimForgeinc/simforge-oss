import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  /*
   * These four stacks were `space-y-2`, a `> * + *` rule StyleX cannot express
   * from the parent. Two of them are `<fieldset>`s, so a flex column is not a
   * substitute either: the rendered legend is not a flex item, and the gap
   * below it — which the margin rule did apply to the control under the legend
   * — would disappear.
   *
   * `stackedMd` carries it from the child instead: an 8px top margin that
   * `:first-child` cancels, which is exactly what `> :not([hidden]) ~
   * :not([hidden])` selected (React renders nothing rather than a hidden
   * element here, and a legend is the first child where there is one). It is
   * passed per usage, never baked into the controls, because the same controls
   * also sit in two-column grids where the gap already spaces them.
   */
  // min-w-0 text-meta
  metaNarrowable: {
    minWidth: "0px",
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
  },
  // font-semibold uppercase tracking-wider text-muted-foreground
  capsMutedSemibold: {
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: colors.mutedForeground,
  },
  // h-8 text-xs
  xs: {
    height: "2rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // grid grid-cols-2 gap-2
  gridCols2Gap2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
  },
  // border border-border bg-muted/20 p-2
  borderedPad2: {
    borderWidth: "1px",
    borderColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.2)",
    padding: space.md,
  },
  // px-1 text-muted-foreground
  muted: {
    paddingLeft: space.xs,
    paddingRight: space.xs,
    color: colors.mutedForeground,
  },
  // border border-border/70 p-2
  borderedPad22: {
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    padding: space.md,
  },
  // col-span-2 grid grid-cols-2 gap-2 border border-border/70 p-2
  gridBorderedCols2: {
    gridColumn: "span 2 / span 2",
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.md,
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    padding: space.md,
  },
  // block min-w-0 text-muted-foreground
  blockMutedNarrowable: {
    display: "block",
    minWidth: "0px",
    color: colors.mutedForeground,
  },
  // mt-1 h-8
  mt1H8: {
    marginTop: space.xs,
    height: "2rem",
  },
  // (was each stack's space-y-2)
  stackedMd: {
    marginTop: {
      default: space.md,
      ":first-child": space.none,
    },
  },
});
