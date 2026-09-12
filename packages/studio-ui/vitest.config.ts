import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const babel = require("@babel/core") as {
  transformSync: (code: string, options: Record<string, unknown>) => { code?: string } | null;
};
const stylexBabelPlugin = require("@stylexjs/babel-plugin");

const stylexVitestPlugin = {
  name: "stylex-vitest",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!/\.stylex\.(?:ts|tsx)$/.test(id)) return;
    return babel.transformSync(code, {
      filename: id,
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
        plugins: [id.endsWith(".tsx") ? "jsx" : "typescript", "typescript"],
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
