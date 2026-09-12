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
  },
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
    color: colors.mutedForeground,
  },
});
