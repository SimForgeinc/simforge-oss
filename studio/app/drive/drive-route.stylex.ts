import * as stylex from "@stylexjs/stylex";
import { driveColors } from "../../../packages/studio-ui/src/drive/drive.stylex";

/**
 * The `/drive` route's own two frames, drawn from Drive's instrument tokens
 * rather than the Studio theme: the layout shell, and the session that fills
 * it. Everything inside a session — HUD, pause menu, pickers — styles itself
 * from `@simforge-oss/studio-ui/drive`; these are the surfaces only the route
 * can own, because only the route knows it is a full-viewport game.
 */
export const route = stylex.create({
  /**
   * The route shell. A session is exactly one viewport tall and never
   * scrolls: the canvas resizes to its box, so a shell that could scroll
   * would let a stray gesture drag the world out of frame.
   */
  shell: {
    height: "100svh",
    overflow: "hidden",
    backgroundColor: driveColors.void,
    color: driveColors.textPrimary,
  },

  /**
   * The session's stacking frame. `relative` is load-bearing: the HUD, the
   * status line and the pause menu are all absolutely positioned against it,
   * and the canvas is the only thing in normal flow.
   */
  session: {
    position: "relative",
    height: "100svh",
    width: "100%",
    overflow: "hidden",
    backgroundColor: driveColors.void,
  },

  /**
   * The world canvas. It is focusable (`role="application"`, `tabIndex={0}`)
   * so the keyboard can reach the car, but it takes no focus ring: the ring
   * would trace the whole viewport, and the HUD is the feedback that the
   * session has the keys.
   */
  canvas: {
    height: "100%",
    width: "100%",
    outlineStyle: { default: null, ":focus-visible": "none" },
  },

  /**
   * The session status line — loading, starting, or why the car could not be
   * placed. Centred over the world because it speaks for the whole scene, and
   * transparent to the mouse so it never eats a drag on the camera.
   */
  status: {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    paddingInline: "1rem",
    paddingBlock: "0.5rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: driveColors.textBody,
  },
});
