import * as stylex from "@stylexjs/stylex";

/**
 * The add-actor panel's two shared surfaces: the chip (a filter, a category, a
 * one-shot action) and the tile (a model, a weather choice, a traffic mode).
 *
 * They live here rather than beside one component because both the catalog
 * rail and the scene panels build out of them, and both carry hover, active and
 * entrance states that an inline `style` cannot express.
 */

const tileIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(8px) scale(0.97)" },
  to: { opacity: 1, transform: "translateY(0) scale(1)" },
});

/**
 * A hovered tile scales its own glyph. StyleX has no descendant selector, so
 * the tile publishes the transform and the glyph reads it.
 */
export const tileIconVars = stylex.defineVars({ transform: "none" });

export const styles = stylex.create({
  // Chips and the close button answer the pointer; the icon rail's own hover
  // wash stays in the component, which already tracks the hovered tool.
  chip: {
    transition: {
      default: "transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 140ms ease, border-color 140ms ease, color 140ms ease",
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transform: {
      default: null,
      ":hover": {
        default: "translateY(-1px)",
        "@media (prefers-reduced-motion: reduce)": "none",
      },
      ":active": {
        default: "translateY(0) scale(0.97)",
        "@media (prefers-reduced-motion: reduce)": "none",
      },
    },
  },

  // The tile owns its resting look here so hover can lift it without an
  // inline style winning the specificity fight.
  tile: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: {
      default: "rgba(255, 255, 255, 0.1)",
      ":hover": "rgba(232, 224, 68, 0.4)",
      // Last word, as in the cascade this replaced: a chosen tile stays lit
      // while the pointer is over it.
      '[data-active="true"]': "rgba(232, 224, 68, 0.62)",
    },
    borderRadius: "13px",
    backgroundColor: {
      default: "rgba(255, 255, 255, 0.045)",
      ":hover": "rgba(232, 224, 68, 0.07)",
      '[data-active="true"]': "rgba(232, 224, 68, 0.12)",
    },
    boxShadow: {
      default: "inset 0 1px 0 rgba(255, 255, 255, 0.03)",
      ":hover": "0 12px 26px rgba(0, 0, 0, 0.42)",
    },
    transition: {
      default: "transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1), border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease",
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transform: {
      default: null,
      ":hover": {
        default: "translateY(-3px)",
        "@media (prefers-reduced-motion: reduce)": "none",
      },
      ":active": {
        default: "translateY(-1px) scale(0.985)",
        "@media (prefers-reduced-motion: reduce)": "none",
      },
    },
    [tileIconVars.transform]: {
      default: "none",
      ":hover": "scale(1.1) translateY(-1px)",
    },
  },

  tileEnter: {
    animationName: {
      default: tileIn,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "220ms",
    animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
    // `backwards`, never `both`: a forwards fill keeps the animation's final
    // transform winning over the hover rules above, so a filled entrance
    // silently disables every hover lift — and leaves a permanent composited
    // layer over the WebGL scene these glass surfaces sample.
    animationFillMode: "backwards",
  },

  tileIcon: {
    transform: {
      default: tileIconVars.transform,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transitionProperty: {
      default: "transform",
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transitionDuration: "200ms",
    transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
  },
});
