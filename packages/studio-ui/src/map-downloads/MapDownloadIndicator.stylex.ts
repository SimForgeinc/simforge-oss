import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, space } from "../stylex/tokens.stylex";

/**
 * The switcher's download badge: a small progress ring pinned to the corner
 * of whatever it decorates (the top bar's logo, the Map Downloads utility).
 */
export const styles = stylex.create({
  root: {
    position: "absolute",
    top: `calc(-1 * ${space.s1})`,
    insetInlineEnd: `calc(-1 * ${space.s1})`,
    width: "1.125rem",
    height: "1.125rem",
    pointerEvents: "none",
  },
  inline: { position: "relative", top: 0, insetInlineEnd: 0, display: "inline-block", flexShrink: 0 },
  svg: { display: "block", width: "100%", height: "100%", transform: "rotate(-90deg)" },
  /** A dark disc under the ring so it reads over the logo. */
  disc: { fill: colors.panelSolid },
  track: { fill: "none", stroke: colors.fillStrong, strokeWidth: 3 },
  arc: {
    fill: "none",
    stroke: colors.accent,
    strokeWidth: 3,
    strokeLinecap: "butt",
    strokeDasharray: "100 100",
    strokeDashoffset: "calc(100 - var(--ring-progress, 0) * 100)",
    transitionProperty: "stroke-dashoffset",
    transitionDuration: { default: motion.durSlow, [layout.reducedMotion]: "0s" },
    transitionTimingFunction: motion.easeStandard,
  },
  arcPaused: { stroke: colors.inkMuted },
  arcFailed: { stroke: colors.critical },
});
