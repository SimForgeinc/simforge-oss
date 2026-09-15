import * as stylex from "@stylexjs/stylex";
import { space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/**
 * The onboarding route shell: one full-height canvas with the hero behind it
 * and one centred column the steps render into. `#050607` is the onboarding
 * canvas the hero gradient fades to, so the area outside a short step matches
 * rather than falling back to the dashboard background.
 */
export const layout = stylex.create({
  shell: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    minHeight: "100svh",
    overflow: "hidden",
    backgroundColor: "#050607",
    paddingInline: space.xxl,
    paddingBlock: "3rem",
    color: "#ffffff",
  },
  column: {
    position: "relative",
    zIndex: 10,
    width: "100%",
    maxWidth: "42rem",
  },
  /**
   * Onboarding has no top bar, so in the desktop shell nothing would drag the
   * window. This strip is the title-bar area the shell reports between its
   * window controls (`env(titlebar-area-*)`); a browser reports none and the
   * fallbacks collapse it to nothing. `.app-topbar-native` makes it drag.
   */
  dragStrip: {
    position: "fixed",
    top: 0,
    left: "env(titlebar-area-x, 0px)",
    width: "env(titlebar-area-width, 0px)",
    height: "env(titlebar-area-height, 0px)",
    zIndex: 1,
  },
});
