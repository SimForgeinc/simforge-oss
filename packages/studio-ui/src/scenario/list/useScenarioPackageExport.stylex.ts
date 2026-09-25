import * as stylex from "@stylexjs/stylex";
import { space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  menuIcon: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  facts: {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    columnGap: space.s3,
    rowGap: space.s1,
    margin: 0,
  },
  factValue: {
    margin: 0,
    minWidth: 0,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    marginTop: space.s4,
  },
  // The file name and the command are copied verbatim: the code face, wrapped anywhere.
  code: {
    fontFamily: text.fontMono,
    overflowWrap: "anywhere",
    margin: 0,
    padding: space.s2,
  },
  commandRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
  },
  commandText: {
    flexGrow: 1,
    minWidth: 0,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
  },
  icon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
