import {
  stylexBabelConfig,
  stylexIncludeGlobs,
} from "./stylex.config.mjs";

/**
 * StyleX runs before Tailwind so its atomic rules land above Tailwind's in the
 * stylesheet. Order is not what decides a conflict, though: StyleX guards every
 * atom with three `:not(#\#)` clauses, so a StyleX rule (0,3,1) outranks any
 * plain Tailwind utility (0,1,0) whatever the order. A caller that needs to
 * beat a property a migrated component declares passes `xstyle`, not a class;
 * `className` carries only what StyleX cannot express.
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
