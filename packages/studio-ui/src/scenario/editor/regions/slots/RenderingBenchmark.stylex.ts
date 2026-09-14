import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  /**
   * The benchmark viewer renders off-screen at the configured 1280x720 so
   * every profile is measured at the same resolution regardless of the page
   * it is launched from. `opacity: 0` rather than `display: none`: WebGL
   * needs a laid-out canvas to produce frames.
   */
  hiddenViewport: {
    pointerEvents: "none",
    position: "fixed",
    left: "-10000px",
    top: 0,
    height: "720px",
    width: "1280px",
    overflow: "hidden",
    opacity: 0,
  },
});
