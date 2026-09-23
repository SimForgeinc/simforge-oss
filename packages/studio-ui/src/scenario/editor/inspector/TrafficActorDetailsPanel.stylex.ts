import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  preview: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s1,
    textAlign: "center",
  },
  icon: {
    width: "2.25rem",
    height: "2.25rem",
    color: colors.inkMuted,
  },
  facts: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: space.s3,
    rowGap: space.s1,
    margin: 0,
  },
  factValue: {
    margin: 0,
    minWidth: 0,
  },
  note: {
    marginTop: space.s3,
    marginBottom: 0,
  },
});
