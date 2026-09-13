import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const babel = require("@babel/core") as {
  transformSync: (code: string, options: Record<string, unknown>) => { code?: string } | null;
};
const stylexBabelPlugin = require("@stylexjs/babel-plugin");

/** This package's own root; only files below it are ours to compile. */
const packageRoot = fileURLToPath(new URL("./", import.meta.url));

/**
 * StyleX is authored wherever a component needs it, not only in `*.stylex.ts`
 * modules — the shared primitives in `src/components/stylex` and the drive
 * screens hold their `create()` calls inline — and an uncompiled `create` /
 * `defineVars` / `keyframes` call throws as soon as the module is imported.
 * The app's webpack rule and PostCSS globs key off the compile roots, so they
 * already cover every file; this plugin matches that by compiling any TS/TSX
 * source under the package that actually makes one of those calls, rather
 * than keying off the filename. `dist` is excluded because it is already
 * compiled, and `node_modules` because it is not ours.
 */
const stylexCallPattern = /\bstylex\s*\.\s*(?:create|defineVars|keyframes)\s*\(/;

const stylexVitestPlugin = {
  name: "stylex-vitest",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    const file = id.split("?", 1)[0];
    if (!/\.(?:ts|tsx)$/.test(file)) return;
    if (!file.startsWith(packageRoot)) return;
    const relative = file.slice(packageRoot.length);
    if (/(?:^|\/)(?:node_modules|dist)\//.test(relative)) return;
    if (!stylexCallPattern.test(code)) return;
    return babel.transformSync(code, {
      filename: file,
      babelrc: false,
      configFile: false,
      plugins: [[stylexBabelPlugin.default ?? stylexBabelPlugin, {
        dev: true,
        runtimeInjection: false,
        treeshakeCompensation: true,
        enableInlinedConditionalMerge: true,
        unstable_moduleResolution: {
          type: "commonJS",
          rootDir: new URL("../../", import.meta.url).pathname,
        },
      }]],
      parserOpts: {
        sourceType: "module",
        plugins: [file.endsWith(".tsx") ? "jsx" : "typescript", "typescript"],
      },
    })?.code;
  },
};
export default defineConfig({
  plugins: [stylexVitestPlugin],
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    environmentOptions: { jsdom: { url: "http://localhost" } },
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // node:test suites; see package.json#scripts.test
      "src/scenario/editor/clipboard/actor-clipboard.test.ts",
      "src/scenario/editor/scene-time.test.ts",
      "src/scenario/editor/simple-timed-routes.test.ts",
    ],
    testTimeout: 10_000,
  },
});
