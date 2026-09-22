import * as stylex from "@stylexjs/stylex";
import { colors } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/**
 * The switcher's dialog geometry (`AppSwitcherOverlay.stylex.ts` `dialog`)
 * applied to a route: fills the dashboard's bounded main area, and
 * carries no open/close animation because nothing opens or closes.
 */
export const styles = stylex.create({
  page: {
    position: "relative",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    color: colors.ink,
  },
});
