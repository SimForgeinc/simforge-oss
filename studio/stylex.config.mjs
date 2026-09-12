/**
 * Single source of truth for the StyleX compiler.
 *
 * StyleX is compiled in two places that MUST agree: `next.config.ts` runs the
 * Babel plugin over the source through webpack (rewriting `stylex.create` /
 * `stylex.defineVars` calls into class names and variable names), and
 * `postcss.config.mjs` runs the same plugin again over the same files to
 * collect the CSS those names refer to. The names are hashed from the plugin
 * options and the file's path relative to `rootDir`, so if the two invocations
 * disagree about a single option the app renders with class names that no
 * stylesheet defines. Hence one exported options object, imported by both.
 *
 * Why not the documented `babel.config.js` setup: a Babel config at the app
 * root switches Next off SWC, and `app/layout.tsx` uses `next/font/google`,
 * which Next refuses to run under Babel (`next-font-unsupported`). Compiling
 * StyleX through an explicit webpack loader rule instead keeps SWC — and
 * therefore `next/font` — untouched.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const studioDir = dirname(fileURLToPath(import.meta.url));

/** Variable and class names are hashed from paths relative to the repo root. */
const repoRoot = join(studioDir, "..");

/**
 * `@simforge-oss/studio-ui` holds the tokens and the shared primitives, so its
 * sources are compiled alongside the app's. Resolved through `package.json`
 * because that file exists whether or not the package has been built yet.
 */
const studioUiDir = dirname(
  createRequire(import.meta.url).resolve("@simforge-oss/studio-ui/package.json"),
);

/**
 * Both trees of the package are compiled, not just one. The dev host imports
 * `studio-ui` through its `development` export condition (`src`), while a
 * production build resolves the same specifier to `dist`. Covering both means
 * the CSS exists whichever way the specifier resolved; the cost is that the
 * token variables are emitted twice in a build that ships both trees, which is
 * a rounding error against being wrong in one of the two modes.
 */
export const stylexCompileRoots = [
  join(studioDir, "app"),
  join(studioUiDir, "src"),
  join(studioUiDir, "dist"),
];

/** Glob form of {@link stylexCompileRoots}, for the PostCSS plugin. */
export const stylexIncludeGlobs = [
  join(studioDir, "app/**/*.{js,jsx,ts,tsx}"),
  join(studioUiDir, "src/**/*.{js,jsx,ts,tsx}"),
  join(studioUiDir, "dist/**/*.js"),
];

/**
 * Options shared by the webpack and PostCSS invocations of the Babel plugin.
 *
 * `runtimeInjection: false` is required: the CSS comes from PostCSS, not from
 * style tags injected at runtime. `dev` keeps readable debug class names in
 * development and must match across both invocations for the same reason
 * everything else here does.
 */
export const stylexBabelOptions = {
  dev: process.env.NODE_ENV !== "production",
  runtimeInjection: false,
  treeshakeCompensation: true,
  enableInlinedConditionalMerge: true,
  unstable_moduleResolution: { type: "commonJS", rootDir: repoRoot },
  /**
   * `@/*` is the app's own alias. The `studio-ui` token entry is pinned to the
   * package's source because StyleX resolves token imports itself, with plain
   * Node conditions — it would land on `dist`, which only exists once the
   * package has been built, and would then name the same variables differently
   * in development (where the app imports `src`) than in a production build.
   * Pinning to `src` makes the generated names identical in both, and makes
   * the app compile against a package that has never been built.
   */
  aliases: {
    "@/*": [join(studioDir, "*")],
    "@simforge-oss/studio-ui/stylex/*": [join(studioUiDir, "src/stylex/*")],
  },
};

/**
 * Babel invocation used by both the loader and PostCSS: parse-only, no
 * presets. Syntax support is selected per extension because a `.ts` file
 * parsed as TSX misreads a generic type argument as a JSX element.
 */
export const stylexBabelConfig = {
  babelrc: false,
  configFile: false,
  browserslistConfigFile: false,
  compact: false,
  plugins: [["@stylexjs/babel-plugin", stylexBabelOptions]],
  overrides: [
    { test: /\.tsx$/, parserOpts: { plugins: ["typescript", "jsx"] } },
    { test: /\.ts$/, parserOpts: { plugins: ["typescript"] } },
    { test: /\.(?:jsx|js|mjs|cjs)$/, parserOpts: { plugins: ["jsx"] } },
  ],
};
