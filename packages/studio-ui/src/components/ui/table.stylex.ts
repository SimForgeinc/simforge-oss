import * as stylex from "@stylexjs/stylex";
import { colors, text } from "../../stylex/tokens.stylex";

const TABLE_TRANSITION = "color, background-color, border-color, text-decoration-color, fill, stroke";

export const styles = stylex.create({
  wrapper: {
    position: "relative",
    width: "100%",
    overflow: "auto",
  },
  table: {
    width: "100%",
    captionSide: "bottom",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  /**
   * `<thead>` and `<tbody>` declare nothing: the baseline's only styling for
   * them was the `[&_tr]` compat strings, which stay on `table.tsx` because
   * they reach rows this element does not render. The keys exist so every
   * part of the table composes through the same
   * `stylex.props(styles.<part>, xstyle)` shape — dropping them would make
   * two of nine parts pass `xstyle` alone, and a later declaration would have
   * nowhere to land.
   */
  header: {},
  body: {},
  footer: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.5)",
    fontWeight: text.weightMedium,
  },
  row: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    transitionProperty: TABLE_TRANSITION,
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--muted) / 0.4)",
      "[data-state=selected]": colors.muted,
    },
  },
  head: {
    height: "2.75rem",
    paddingInline: "1rem",
    textAlign: "left",
    verticalAlign: "middle",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  cell: {
    paddingInline: "1rem",
    paddingBlock: "0.875rem",
    verticalAlign: "middle",
  },
  caption: {
    marginTop: "1rem",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
});
