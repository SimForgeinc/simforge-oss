import * as stylex from "@stylexjs/stylex";
import { colors } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  /**
   * The viewport, split into the top bar and `main` in normal flow: `main` starts at the bar's bottom
   * and ends at the viewport's, whatever the bar's height. Clipped with `scroll.clip` in the layout.
   */
  divFlex: {
    display: "flex",
    height: "100svh",
    flexDirection: "column",
    backgroundColor: colors.bg,
  },
  // The route, never the dashboard host, owns scrolling: `main` is clipped (`scroll.clip`), so
  // nothing can scroll it, and each route puts its own scrollers inside.
  main: {
    flex: "1 1 0%",
    minHeight: 0,
    minWidth: 0,
  },
  // h-full min-h-0
  div: {
    height: "100%",
    minHeight: 0,
    minWidth: 0,
  },
});
