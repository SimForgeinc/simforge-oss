import * as stylex from "@stylexjs/stylex";
import { colors, motion, shadows, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  list: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: "2.25rem",
    backgroundColor: colors.muted,
    padding: space.s1,
    color: colors.mutedForeground,
  },
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    whiteSpace: "nowrap",
    paddingInline: space.s3,
    paddingBlock: space.s1,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightMedium,
    transitionProperty: "all",
    transitionDuration: motion.durStandard,
    transitionTimingFunction: motion.easeStandard,
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineColor: { default: null, ":focus-visible": colors.ring },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": 0.5 },
    backgroundColor: { default: null, "[data-state=active]": colors.bg },
    color: { default: null, "[data-state=active]": colors.text },
    boxShadow: { default: null, "[data-state=active]": shadows.elevationSm },
  },
  content: {
    marginTop: space.s4,
  },
});
