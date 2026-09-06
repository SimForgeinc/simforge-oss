import { defineConfig } from "vitest/config";

export default defineConfig({
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
