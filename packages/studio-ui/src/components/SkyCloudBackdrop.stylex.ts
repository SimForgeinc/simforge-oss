/**
 * StyleX styles for `SkyCloudBackdrop`, plus the cloud plate itself.
 *
 * `cloudPlate` is exported because two surfaces draw the same painted sky: the
 * backdrop's un-animated branch, and the dashboard top bar's own cloud layer.
 * It used to be the `app-topbar-clouds` global class; it lives here now, and
 * `AppTopBar.stylex.ts` re-exports it rather than restating the gradient.
 */

import * as stylex from "@stylexjs/stylex";

/**
 * The plate's slow parallax. Two long `translate3d` + `scale` stops played
 * `alternate`, so the field breathes rather than looping back to its start.
 */
const drift = stylex.keyframes({
  from: { transform: "translate3d(-1.5%, 0, 0) scale(1.04)" },
  to: { transform: "translate3d(1.5%, -2%, 0) scale(1.08)" },
});

/**
 * The five lobes, comma-joined as one `background-image`. A StyleX array
 * value means fallback declarations, not a comma list, so the list is one
 * string; CSS ignores the newlines inside it.
 */
const CLOUD_LOBES = `
  radial-gradient(ellipse 16% 34% at 7% 50%, rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.12) 44%, transparent 76%),
  radial-gradient(ellipse 22% 40% at 27% 58%, rgba(255, 255, 255, 0.17) 0%, rgba(255, 255, 255, 0.08) 48%, transparent 78%),
  radial-gradient(ellipse 19% 38% at 51% 43%, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0.09) 45%, transparent 76%),
  radial-gradient(ellipse 24% 42% at 74% 59%, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.07) 50%, transparent 80%),
  radial-gradient(ellipse 17% 35% at 95% 46%, rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.1) 45%, transparent 76%)
`;

/**
 * Five overlapping white ellipses, blurred into cloud cover.
 *
 * The gradients were authored as one `background` shorthand; they are a
 * `background-image` here because nothing paints a colour, position or size
 * behind them, so the shorthand's other longhands were already at their
 * initial values.
 *
 * `will-change` is unconditional, as it was in CSS: `prefers-reduced-motion`
 * cancels the drift, not the compositing hint.
 */
export const cloudPlate = stylex.create({
  plate: {
    backgroundImage: CLOUD_LOBES,
    filter: "blur(11px)",
    opacity: 0.95,
    animationName: {
      default: drift,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "16s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    animationDirection: "alternate",
    willChange: "transform",
  },
});

export const styles = stylex.create({
  /**
   * absolute inset-0 overflow-hidden bg-black/60 backdrop-blur-[42px]
   * backdrop-saturate-0 backdrop-contrast-125 before:absolute before:inset-0
   * before:bg-[radial-gradient(…)]
   *
   * The composite `backdrop-filter` keeps Tailwind's own ordering — blur,
   * contrast, saturate — because filters are not commutative. The `::before`
   * layer is the vignette that pulls the centre of the sky forward; Tailwind's
   * `before:` variants supply the empty `content` that makes it render.
   */
  root: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    backgroundColor: "rgb(0 0 0 / 0.6)",
    backdropFilter: "blur(42px) contrast(1.25) saturate(0)",
    "::before": {
      content: "",
      position: "absolute",
      inset: 0,
      backgroundImage:
        "radial-gradient(circle at 50% 46%, rgba(255,255,255,0.07) 0%, rgba(18,19,20,0.18) 38%, rgba(2,3,4,0.72) 100%)",
    },
  },
  /** absolute inset-0 — the box the shared `cloudPlate` is painted into. */
  staticClouds: { position: "absolute", inset: 0 },
});
