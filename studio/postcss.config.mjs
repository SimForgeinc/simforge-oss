import {
  stylexBabelConfig,
  stylexIncludeGlobs,
} from "./stylex.config.mjs";

/**
 * StyleX runs before Tailwind so its atomic rules land above Tailwind's in the
 * stylesheet. Both produce single-class selectors, so cascade order is the only
 * tie-break: during the additive migration a component styled with StyleX can
 * still be overridden by a Tailwind class passed in by an unmigrated caller,
 * which is what keeps the pixels identical.
 *
 * `useCSSLayers` stays off for the same reason, and because Tailwind 3 fails on
 * `@layer` names it does not own.
 */
export default {
  plugins: {
    "@stylexjs/postcss-plugin": {
      include: stylexIncludeGlobs,
      useCSSLayers: false,
      babelConfig: stylexBabelConfig,
    },
    tailwindcss: {},
    autoprefixer: {},
  },
};
