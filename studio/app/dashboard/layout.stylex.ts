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
  // The route, never the dashboard host, owns scrolling.
  main: {
    flex: "1 1 0%",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
  },
  // h-full min-h-0
  div: {
    height: "100%",
    minHeight: 0,
    minWidth: 0,
  },
});
