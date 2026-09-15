import * as stylex from "@stylexjs/stylex";
import { colors } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  // flex h-svh flex-col overflow-hidden bg-background
  divFlex: {
    display: "flex",
    height: "100svh",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: colors.bg,
  },
  // flex-1 min-h-0 overflow-y-auto
  main: {
    flex: "1 1 0%",
    minHeight: 0,
    overflowY: "auto",
  },
  // h-full min-h-0
  div: {
    height: "100%",
    minHeight: 0,
  },
});
