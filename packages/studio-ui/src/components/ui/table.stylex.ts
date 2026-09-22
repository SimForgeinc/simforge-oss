import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "../../stylex/tokens.stylex";

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
    lineHeight: text.lineSm,
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
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    backgroundColor: "hsl(var(--muted) / 0.5)",
    fontWeight: text.weightMedium,
  },
  row: {
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    transitionProperty: TABLE_TRANSITION,
    transitionDuration: motion.durStandard,
    transitionTimingFunction: motion.easeStandard,
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--muted) / 0.4)",
      "[data-state=selected]": colors.muted,
    },
  },
  head: {
    height: "2.75rem",
    paddingInline: space.s4,
    textAlign: "left",
    verticalAlign: "middle",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: text.trackingWider,
  },
  cell: {
    paddingInline: space.s4,
    paddingBlock: space.s3_5,
    verticalAlign: "middle",
  },
  caption: {
    marginTop: space.s4,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
});
