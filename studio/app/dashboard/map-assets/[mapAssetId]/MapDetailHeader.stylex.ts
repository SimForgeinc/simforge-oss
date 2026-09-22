import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion, shadows, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

export const styles = stylex.create({
  headerNavigationGroup: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space.s2,
  },
  backToMapsLink: {
    display: "flex",
    height: "2.5rem",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s2,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
    backgroundColor: { default: null, ":hover": "hsl(var(--foreground) / 0.08)" },
    /*
     * `focus-visible:outline-none` is Tailwind's transparent 2px outline, not
     * `outline: none`: the focus ring above is a box-shadow, which
     * forced-colours mode discards, and this transparent outline is what
     * remains visible there.
     */
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": shadows.ring },
  },
  sharedActionIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  backToMapsLabel: {
    display: { default: "none", [layout.bpLg]: "inline" },
  },
  backLabel: {
    display: { default: null, [layout.bpLg]: "none" },
  },
  headerNavigationDivider: {
    display: { default: "none", [layout.bpMd]: "block" },
    height: "1.25rem",
    width: "1px",
    flexShrink: 0,
    backgroundColor: colors.border,
  },
  createScenarioButton: {
    gap: space.s1_5,
  },
  actionsMenuTrigger: {
    marginLeft: space.s2,
    width: "2.5rem",
    height: "2.5rem",
    flexShrink: 0,
    color: { default: "hsl(var(--foreground) / 0.7)", ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
    backgroundColor: { default: null, ":hover": "hsl(var(--foreground) / 0.08)" },
  },
  actionsMenuLabel: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
  actionsMenuContent: {
    width: "12rem",
  },
  menuItemIcon: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  headerActionIcon: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  spinning: {
    animationName: spin,
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
  },
  actionTooltip: {
    maxWidth: "20rem",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
  },
  pulsing: {
    animationName: pulse,
    animationDuration: motion.durPulse,
    animationTimingFunction: motion.easePulse,
    animationIterationCount: "infinite",
  },
});
