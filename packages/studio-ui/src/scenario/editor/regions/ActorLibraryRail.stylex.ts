import * as stylex from "@stylexjs/stylex";
import { colors, layout, motion } from "../../../stylex/tokens.stylex";

/* ─────────────────────────────────────────────────────────────
 * Add-actor panel motion
 *
 * The panel is the icon rail growing sideways, so it enters from
 * under the rail (which sits one z-index above it) rather than
 * fading in on top of the map. Its contents arrive just behind
 * it, staggered, so a wall of forty models reads as a list being
 * dealt out instead of a block appearing.
 * ───────────────────────────────────────────────────────────── */
const panelIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateX(-30px)" },
  to: { opacity: 1, transform: "translateX(0)" },
});

const chipIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-5px)" },
  to: { opacity: 1, transform: "translateY(0)" },
});

const tooltipIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateX(-9px) scale(0.92)" },
  to: { opacity: 1, transform: "translateX(0) scale(1)" },
});

/**
 * A hovered or pressed tool scales its own glyph. StyleX has no descendant
 * selector, so the button publishes the transform and the glyph reads it.
 */
export const toolIconVars = stylex.defineVars({ transform: "none" });

export const styles = stylex.create({
  // pointer-events-auto flex h-full min-h-0 items-center
  flexCenterLive: {
    pointerEvents: "auto",
    display: "flex",
    height: "100%",
    minHeight: "0px",
    alignItems: "center",
  },

  // `backwards`, never `both`: a forwards fill keeps the animation's final
  // transform winning over the hover rules these surfaces carry, so a filled
  // entrance silently disables every hover lift — and leaves a permanent
  // composited layer over the WebGL scene this glass samples.
  panelEnter: {
    animationName: {
      default: panelIn,
      [layout.reducedMotion]: "none",
    },
    animationDuration: "240ms",
    animationTimingFunction: motion.easeExpressive,
    animationFillMode: "backwards",
    willChange: "transform, opacity",
  },

  chipEnter: {
    animationName: {
      default: chipIn,
      [layout.reducedMotion]: "none",
    },
    animationDuration: "200ms",
    animationTimingFunction: motion.easeExpressive,
    animationFillMode: "backwards",
  },

  railTooltip: {
    animationName: {
      default: tooltipIn,
      [layout.reducedMotion]: "none",
    },
    animationDuration: "130ms",
    animationTimingFunction: motion.easeExpressive,
    animationFillMode: "backwards",
  },

  toolButton: {
    [toolIconVars.transform]: {
      default: "none",
      ":hover": "scale(1.16)",
      // Last word, as in the cascade this replaced: the pressed tool keeps its
      // own resting scale while the pointer is over it.
      '[aria-pressed="true"]': "scale(1.08)",
    },
  },

  toolIcon: {
    transform: {
      default: toolIconVars.transform,
      [layout.reducedMotion]: "none",
    },
    transitionProperty: {
      default: "transform",
      [layout.reducedMotion]: "none",
    },
    transitionDuration: "200ms",
    transitionTimingFunction: motion.easeExpressive,
  },

  panelClose: {
    transition: {
      default: "transform 180ms cubic-bezier(0.16, 1, 0.3, 1), background-color 140ms ease, color 140ms ease",
      [layout.reducedMotion]: "none",
    },
    transform: {
      default: null,
      ":hover": {
        default: "rotate(90deg)",
        [layout.reducedMotion]: "none",
      },
    },
    backgroundColor: { default: null, ":hover": colors.fillStrong },
    color: { default: null, ":hover": colors.ink },
  },

  /*
   * The catalog's drag edge. Invisible until wanted: a permanent bar down the
   * panel's side would read as a border on a surface whose whole right edge is
   * already a rounded glass rim. The grip only appears under the pointer or on
   * focus, which is also the only time it means anything.
   */
  panelResize: {
    outline: { default: null, ":focus-visible": "none" },
    "::after": {
      content: '""',
      position: "absolute",
      top: "50%",
      right: "2px",
      width: "3px",
      height: "34px",
      transform: "translateY(-50%)",
      borderRadius: "2px",
      backgroundColor: {
        default: "rgba(232, 224, 68, 0)",
        ":hover": "rgba(232, 224, 68, 0.72)",
        ":focus-visible": "rgba(232, 224, 68, 0.72)",
      },
      transition: "background-color 140ms ease",
    },
  },
});
