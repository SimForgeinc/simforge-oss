import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../stylex/tokens.stylex";

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
  footer: {
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderTopColor: colors.hairline,
    backgroundColor: colors.fillSubtle,
    fontWeight: text.weightMedium,
  },
  row: {
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: colors.hairline,
    backgroundColor: {
      default: null,
      ":hover": colors.fillSubtle,
      "[data-state=selected]": colors.muted,
    },
  },
  head: {
    height: "2.75rem",
    paddingInline: space.s4,
    textAlign: "left",
    verticalAlign: "middle",
    color: colors.mutedForeground,
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
