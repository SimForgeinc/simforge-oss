import * as stylex from "@stylexjs/stylex";
import { space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/**
 * The onboarding route shell: one viewport-height canvas with the hero behind
 * it and one centred column the steps render into. `#050607` is the onboarding
 * canvas the hero gradient fades to, so the area outside a short step matches
 * rather than falling back to the dashboard background.
 *
 * The shell owns the viewport rather than growing past it: first run is three
 * short decisions, and a step that scrolls hides the very button it is asking
 * the user to press. `height` (not `minHeight`) with `overflow: hidden` makes
 * the page unscrollable by construction, which in turn makes the column's
 * height *definite* — that is what lets a step hand its flexible region (the
 * map grid) the space left over from its heading and its actions instead of
 * measuring anything.
 */
export const layout = stylex.create({
  shell: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100svh",
    overflow: "hidden",
    backgroundColor: "#050607",
    paddingInline: space.xxl,
    paddingBlock: "2rem",
    color: "#ffffff",
  },
  /**
   * Full height so a step that wants the whole viewport (the map grid) can
   * take it, and `justifyContent: center` so a step that does not (welcome,
   * native render) still reads as centred rather than pinned to the top.
   */
  column: {
    position: "relative",
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    width: "100%",
    maxWidth: "48rem",
    height: "100%",
    minHeight: 0,
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

/**
 * The inline SimCloud account flow, as onboarding places it.
 *
 * `CloudAccountPanel` is written for the Settings plate and the SimCloud
 * panel, where a 26rem measure keeps the form readable beside other content.
 * Onboarding composes it into `column` instead, where every other row — the
 * welcome actions, the map list, the download button — runs the column's
 * full measure, so that clamp reads as a narrow card dropped into the flow.
 * Releasing it hands the measure back to `column`'s own 42rem cap rather
 * than restating a width that would then have to be kept in step with it.
 */
export const inlineSignIn = stylex.create({
  panel: { maxWidth: "none" },
});
