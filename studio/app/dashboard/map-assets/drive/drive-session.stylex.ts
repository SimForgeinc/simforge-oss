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
import { layout, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/**
 * The session's frame, drawn from Drive's instrument tokens rather than the
 * Studio theme. Everything inside — HUD, pause menu, pickers — styles itself
 * from `@simforge-oss/studio-ui/drive`; this is the surface only the host can
 * own, because only the host knows what box the game fills.
 */
export const driveFrame = stylex.create({
  /**
   * A drive route's page box: the shared world's viewport is leased into it
   * and the session is laid over that. `relative` is load-bearing for both.
   * It fills whatever the dashboard gives it and never scrolls: the canvas
   * resizes to its box, so a frame that could scroll would let a stray gesture
   * drag the world out of frame.
   */
  route: {
    position: "relative",
    height: "100%",
    width: "100%",
    overflow: "hidden",
    backgroundColor: driveColors.void,
  },

  /** Where the leased world paints inside a drive route. */
  world: {
    position: "absolute",
    inset: 0,
  },

  /**
   * The session's stacking frame, laid over the shared world's viewport. It
   * fills the box the host gives it and never scrolls: the HUD, the status
   * line and the pause menu are all absolutely positioned against it, and it
   * paints nothing of its own — the world underneath is the picture. It takes
   * the pointer so the orbit view can be dragged over a canvas that is not
   * interactive while a drive owns its camera.
   */
  session: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    color: driveColors.textPrimary,
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
  /**
   * The take's own controls: start, and keep or discard a recorded clip.
   * Top-centre under the clip countdown, clear of the car the chase camera
   * frames, and the one panel here that takes the mouse — these are the only
   * buttons that decide whether anything is written into the scenario.
   */
  take: {
    position: "absolute",
    left: "50%",
    top: space.s12,
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    padding: space.s3,
    maxWidth: layout.formMeasure,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    pointerEvents: "auto",
    color: driveColors.textBody,
  },
  takeActions: {
    display: "flex",
    gap: space.s2,
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
