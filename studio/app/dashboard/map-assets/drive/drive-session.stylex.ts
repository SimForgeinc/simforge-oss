import * as stylex from "@stylexjs/stylex";
// `driveColors` is a `defineVars` group, and StyleX resolves those imports
// itself, through plain Node conditions and then `stylex.config.mjs`'s
// aliases — never through the app's `@/*` or the workspace layout. Both
// copies of the package are compile roots, so whichever this resolves to
// (`dist` once the package is built, `src` through the alias before it is)
// its variable names have CSS. What must not happen is reaching across the
// app's own directory: this app is vendored into hosts that have no sibling
// `packages/` at all, and a relative path out of `app/` cannot be resolved
// there. The public subpath is the specifier every consumer can resolve.
import { driveColors } from "@simforge-oss/studio-ui/drive/drive.stylex";

/**
 * The session's frame, drawn from Drive's instrument tokens rather than the
 * Studio theme. Everything inside — HUD, pause menu, pickers — styles itself
 * from `@simforge-oss/studio-ui/drive`; this is the surface only the host can
 * own, because only the host knows what box the game fills.
 */
export const driveFrame = stylex.create({
  /**
   * The session's stacking frame. `relative` is load-bearing: the HUD, the
   * status line and the pause menu are all absolutely positioned against it,
   * and the canvas is the only thing in normal flow. It fills whatever the
   * host gives it and never scrolls: the canvas resizes to its box, so a frame
   * that could scroll would let a stray gesture drag the world out of frame.
   */
  session: {
    position: "relative",
    height: "100%",
    width: "100%",
    overflow: "hidden",
    backgroundColor: driveColors.void,
    color: driveColors.textPrimary,
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

  /**
   * How much clip is left. Top-centre, above the HUD's own instruments: the
   * countdown is the one thing that decides when the drive ends, so it sits
   * where the driver's eyes already are rather than in a corner. Transparent to
   * the mouse, like the status line.
   */
  clip: {
    position: "absolute",
    left: "50%",
    top: "1rem",
    transform: "translateX(-50%)",
    pointerEvents: "none",
    paddingInline: "0.75rem",
    paddingBlock: "0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: driveColors.textBody,
  },
  controlSource: {
    position: "absolute",
    right: "1rem",
    top: "1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    padding: "0.75rem",
    maxWidth: "22rem",
    fontSize: "0.75rem",
    pointerEvents: "auto",
    color: driveColors.textBody,
  },
});
