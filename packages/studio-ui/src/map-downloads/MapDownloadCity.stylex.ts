import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion } from "../stylex/tokens.stylex";

/**
 * The isometric city a map download builds. Geometry is in the SVG's own
 * units; everything here is paint and the rise transition. Colour and opacity
 * carry the state, and the one transform (a block rising out of its lot) is
 * dropped under reduced motion: the block simply appears.
 */
export const styles = stylex.create({
  svg: { display: "block", width: "100%", height: "100%", overflow: "visible" },
  lot: {
    fill: colors.fillFaint,
    stroke: colors.hairlineStrong,
    strokeWidth: 0.02,
    transitionProperty: "fill, stroke",
    transitionDuration: { default: motion.durSlow, [layout.reducedMotion]: "0s" },
    transitionTimingFunction: motion.easeStandard,
  },
  lotLit: { fill: colors.accentWash, stroke: colors.accentLineSubtle },
  /** The lot whose files are transferring now: its outline breathes. */
  lotActive: { stroke: colors.accent, strokeWidth: 0.05 },
  streets: {
    fill: "none",
    stroke: colors.hairline,
    strokeWidth: 0.03,
    transitionProperty: "stroke",
    transitionDuration: { default: motion.durSlow, [layout.reducedMotion]: "0s" },
    transitionTimingFunction: motion.easeStandard,
  },
  streetsLit: { stroke: colors.accentLine },
  building: {
    opacity: 0,
    transform: "translateY(calc(var(--rise) * 1px))",
    transitionProperty: "transform, opacity",
    transitionDuration: { default: motion.durSlow, [layout.reducedMotion]: "0s" },
    transitionTimingFunction: motion.easeExpressive,
  },
  buildingLit: { opacity: 1, transform: "translateY(0)" },
  roof: { fill: colors.accent },
  wallLeft: { fill: colors.accentLine },
  wallRight: { fill: colors.accentLineSubtle },
  /** Foliage lots carry a small canopy once their trees are down. */
  canopy: { fill: colors.inkSecondary, opacity: 0.55 },
});
