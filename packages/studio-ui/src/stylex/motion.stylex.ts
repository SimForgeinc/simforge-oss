import * as stylex from "@stylexjs/stylex";

/**
 * The editor's one shared transition, previously the `.editor-motion` utility
 * in `styles.css`.
 *
 * Every literal is carried over unchanged, because this is the only motion the
 * editor shell has and forty-odd controls share it:
 *
 *   - the property list is colour and opacity only. Geometry is deliberately
 *     absent: a transitioned `transform` or `width` on editor chrome fights the
 *     WebGL scene underneath it, which is why `.render-surface-motion` exists
 *     separately for the few surfaces that do move.
 *   - `cubic-bezier(0.2, 0.8, 0.2, 1)` is the editor's snappy curve
 *     (`motion.easeSnappy`), and 150ms sits between `durFast` and `durBase`;
 *     neither is a token because the pair is this transition's identity and
 *     rounding either would change what the editor feels like.
 *   - under `prefers-reduced-motion: reduce` there is no transition at all.
 *     The old rule was `transition: none !important`, so both the property list
 *     and the duration are neutralised here rather than only one of them: a
 *     caller composing a Tailwind `duration-*`/`transition-*` class on the same
 *     element must not be able to resurrect the animation.
 *
 * Composed last in a `stylex.props()` call it would win on conflict, so it is
 * passed first at callsites that also set their own transition.
 */
export const motionStyles = stylex.create({
  editorMotion: {
    transitionProperty: {
      default:
        "color, background-color, border-color, text-decoration-color, fill, stroke, opacity",
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    transitionDuration: {
      default: "150ms",
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
  },
});
