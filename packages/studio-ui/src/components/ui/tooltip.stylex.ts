import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, radii, text } from "../../stylex/tokens.stylex";

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = stylex.keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });
const zoomIn = stylex.keyframes({ from: { transform: "scale(0.95)" }, to: { transform: "scale(1)" } });
const zoomOut = stylex.keyframes({ from: { transform: "scale(1)" }, to: { transform: "scale(0.95)" } });
const slideTop = stylex.keyframes({ from: { transform: "translateY(0.5rem)" }, to: { transform: "translateY(0)" } });
const slideBottom = stylex.keyframes({ from: { transform: "translateY(-0.5rem)" }, to: { transform: "translateY(0)" } });
const slideLeft = stylex.keyframes({ from: { transform: "translateX(0.5rem)" }, to: { transform: "translateX(0)" } });
const slideRight = stylex.keyframes({ from: { transform: "translateX(-0.5rem)" }, to: { transform: "translateX(0)" } });

export const styles = stylex.create({
  content: {
    zIndex: layers.popover, overflow: "hidden", borderRadius: radii.md, borderWidth: 1, borderStyle: "solid", borderColor: colors.border,
    backgroundColor: colors.popover, paddingInline: "0.75rem", paddingBlock: "0.375rem", fontSize: text.sizeSm, lineHeight: "1.25rem", color: colors.text,
    boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
    transformOrigin: "var(--radix-tooltip-content-transform-origin)",
    animationDuration: motion.durBase, animationTimingFunction: motion.easeOut,
    animationName: {
      default: null,
      "[data-state=open]": fadeIn,
      "[data-state=closed]": fadeOut,
      "[data-side=bottom]": slideTop,
      "[data-side=left]": slideRight,
      "[data-side=right]": slideLeft,
      "[data-side=top]": slideBottom,
    },
    transform: { default: "scale(1)", "[data-state=open]": "scale(1)", "[data-state=closed]": "scale(0.95)" },
  },
});
