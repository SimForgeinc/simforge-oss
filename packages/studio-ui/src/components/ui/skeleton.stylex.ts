import * as stylex from "@stylexjs/stylex";
import { colors } from "../../stylex/tokens.stylex";

/**
 * The placeholder's breathing cycle, matching Tailwind's `animate-pulse`
 * exactly: 2s, `cubic-bezier(0.4, 0, 0.6, 1)`, infinite.
 *
 * Only the 50% stop is declared, which is how Tailwind's own `pulse`
 * keyframes are written. The omission is load-bearing rather than terse: with
 * no 0%/100% stop the animation interpolates from whatever opacity the
 * element already has, so a caller that dims a skeleton keeps its dimming.
 * Pinning 0%/100% to `1` would quietly brighten those cases.
 *
 * Deliberately unguarded by `prefers-reduced-motion`: `animate-pulse` carries
 * no guard today either, and `styles.css` guards only the editor's own
 * `.editor-pulse`. Adding one here would change behaviour for reduced-motion
 * users, which this migration is not allowed to do.
 */
const pulse = stylex.keyframes({
  "50%": { opacity: 0.5 },
});

export const styles = stylex.create({
  /**
   * `rounded-md` is intentionally absent: the global sharp-corner reset in
   * `styles.css` (`*, *::before, *::after { border-radius: 0 !important }`)
   * makes every radius inert, so the utility contributed nothing to render.
   */
  base: {
    backgroundColor: colors.muted,
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
  },
});
