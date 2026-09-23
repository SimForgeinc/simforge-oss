import * as stylex from "@stylexjs/stylex";

import { colors, layers, space, stroke } from "../../../stylex/tokens.stylex";

/**
 * The simulation player's controls and its chased-actor label. Layout only:
 * the plate, hairlines, type and focus come from recipes in the components.
 */
export const styles = stylex.create({
  /** Bottom-centre dock over the viewport; the layer around it passes clicks through. */
  dock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: space.s4,
    display: "flex",
    justifyContent: "center",
    paddingInline: space.s4,
    pointerEvents: "none",
  },
  bar: {
    display: "grid",
    gridTemplateColumns: "auto auto minmax(8rem, 1fr) auto auto",
    alignItems: "center",
    gap: space.s3,
    width: "100%",
    maxWidth: space.shellWidth,
    minWidth: 0,
    paddingInline: space.s2,
    paddingBlock: space.s2,
    pointerEvents: "auto",
  },
  time: {
    minWidth: space.s12,
    whiteSpace: "nowrap",
  },
  /** The whole strip is the hit target; the drawn track is a thin line inside it. */
  scrubber: {
    position: "relative",
    height: space.s6,
    minWidth: 0,
    cursor: "pointer",
    touchAction: "none",
  },
  track: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    height: stroke.thick,
    transform: "translateY(-50%)",
    backgroundColor: colors.fillStronger,
  },
  /** `progress` is the played share of the clip, a percentage. */
  progress: (progress: string) => ({
    position: "absolute",
    left: 0,
    top: "50%",
    width: progress,
    height: stroke.thick,
    transform: "translateY(-50%)",
    backgroundColor: colors.accent,
  }),
  thumb: (progress: string) => ({
    position: "absolute",
    top: "50%",
    left: progress,
    width: space.s2_5,
    height: space.s2_5,
    transform: "translate(-50%, -50%)",
    backgroundColor: colors.accent,
  }),
  chase: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    maxWidth: space.railWidth,
  },
  chaseText: {
    display: "grid",
    minWidth: 0,
  },
  hint: {
    whiteSpace: "nowrap",
  },
  /** Floats over the chased actor; `use-chase-camera` writes its position every frame. */
  label: {
    position: "fixed",
    left: 0,
    top: 0,
    zIndex: layers.editorOverlay,
    maxWidth: space.railWidth,
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    pointerEvents: "none",
    opacity: "var(--chase-label-opacity, 0)",
    transform: "translate(var(--chase-label-x, 0px), var(--chase-label-y, 0px)) translate(-50%, -100%)",
  },
});
