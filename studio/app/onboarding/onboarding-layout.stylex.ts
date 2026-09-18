import * as stylex from "@stylexjs/stylex";

/**
 * What the onboarding route adds to the shared hero shell
 * (`HeroFlowShell`, which owns the canvas, the backdrop and the column).
 * Both are host-side placement, not art direction: the drag strip exists
 * because this route has no top bar, and the sign-in override exists because
 * this route composes a panel written for a narrower plate.
 */
export const layout = stylex.create({
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

/**
 * The inline SimCloud account flow, as the hero flow places it.
 *
 * `CloudAccountPanel` is written for the Settings plate and the SimCloud
 * panel, where a 26rem measure keeps the form readable beside other content.
 * The flow composes it into the shell's column instead, where every other
 * row — the welcome actions, the map grid, the download button — runs the
 * column's full measure, so that clamp reads as a narrow card dropped into
 * the flow. Releasing it hands the measure back to the column's own cap
 * rather than restating a width that would then have to be kept in step.
 */
export const inlineSignIn = stylex.create({
  panel: { maxWidth: "none" },
});
