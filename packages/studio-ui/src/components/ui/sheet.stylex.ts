import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, radii, text } from "../../stylex/tokens.stylex";

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = stylex.keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });
const slideTopIn = stylex.keyframes({ from: { transform: "translateY(-100%)" }, to: { transform: "translateY(0)" } });
const slideTopOut = stylex.keyframes({ from: { transform: "translateY(0)" }, to: { transform: "translateY(-100%)" } });
const slideBottomIn = stylex.keyframes({ from: { transform: "translateY(100%)" }, to: { transform: "translateY(0)" } });
const slideBottomOut = stylex.keyframes({ from: { transform: "translateY(0)" }, to: { transform: "translateY(100%)" } });
const slideLeftIn = stylex.keyframes({ from: { transform: "translateX(-100%)" }, to: { transform: "translateX(0)" } });
const slideLeftOut = stylex.keyframes({ from: { transform: "translateX(0)" }, to: { transform: "translateX(-100%)" } });
const slideRightIn = stylex.keyframes({ from: { transform: "translateX(100%)" }, to: { transform: "translateX(0)" } });
const slideRightOut = stylex.keyframes({ from: { transform: "translateX(0)" }, to: { transform: "translateX(100%)" } });

const stateMotion = {
  default: null,
  "[data-state=open]": { animationName: fadeIn },
  "[data-state=closed]": { animationName: fadeOut },
};

export const styles = stylex.create({
  overlay: {
    position: "fixed", inset: 0, zIndex: layers.popover, backgroundColor: "rgba(0, 0, 0, 0.8)",
    animationDuration: motion.durBase, animationTimingFunction: motion.easeOut,
    ...stateMotion,
  },
  content: {
    position: "fixed", zIndex: layers.popover, display: "flex", flexDirection: "column", gap: "1rem",
    backgroundColor: colors.bg, padding: "1.5rem", boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    transitionProperty: "all", transitionTimingFunction: motion.easeOut,
    animationDuration: { default: motion.durBase, "[data-state=closed]": motion.durInstant },
    ...stateMotion,
  },
  top: { insetInline: 0, top: 0, borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: colors.border, animationName: { default: null, "[data-state=open]": slideTopIn, "[data-state=closed]": slideTopOut } },
  bottom: { insetInline: 0, bottom: 0, borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: colors.border, animationName: { default: null, "[data-state=open]": slideBottomIn, "[data-state=closed]": slideBottomOut } },
  left: { insetBlock: 0, left: 0, width: "75%", height: "100%", borderRightWidth: 1, borderRightStyle: "solid", borderRightColor: colors.border, animationName: { default: null, "[data-state=open]": slideLeftIn, "[data-state=closed]": slideLeftOut }, "@media (min-width: 640px)": { maxWidth: "24rem" } },
  right: { insetBlock: 0, right: 0, width: "75%", height: "100%", borderLeftWidth: 1, borderLeftStyle: "solid", borderLeftColor: colors.border, animationName: { default: null, "[data-state=open]": slideRightIn, "[data-state=closed]": slideRightOut }, "@media (min-width: 640px)": { maxWidth: "24rem" } },
  close: {
    position: "absolute", top: "1rem", right: "1rem", borderRadius: radii.sm, opacity: 0.7,
    transitionProperty: "opacity", transitionDuration: motion.durBase,
    ":hover": { opacity: 1 },
    // `focus:outline-none` is Tailwind's transparent 2px outline, not `outline: none`,
    // so forced-colours mode still has an outline to repaint.
    ":focus": {
      outlineWidth: "2px", outlineStyle: "solid", outlineColor: "transparent", outlineOffset: "2px",
      boxShadow: `0 0 0 2px ${colors.ring}, 0 0 0 4px ${colors.bg}`,
    },
    ":disabled": { pointerEvents: "none" }, "[data-state=open]": { backgroundColor: colors.secondary },
  },
  closeIcon: { width: "1rem", height: "1rem" },
  header: { display: "flex", flexDirection: "column", gap: "0.5rem", textAlign: { default: "center", "@media (min-width: 640px)": "left" } },
  footer: { display: "flex", flexDirection: "column-reverse", gap: "0.5rem", "@media (min-width: 640px)": { flexDirection: "row", justifyContent: "flex-end" } },
  title: { fontSize: text.sizeLg, lineHeight: "1.75rem", fontWeight: text.weightSemibold, color: colors.text },
  description: { fontSize: text.sizeSm, lineHeight: "1.25rem", color: colors.mutedForeground },
  srOnly: { position: "absolute", width: "1px", height: "1px", padding: 0, margin: "-1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", borderWidth: 0 },
});
