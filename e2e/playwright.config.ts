import { defineConfig } from "@playwright/test";

/**
 * One config for every E2E project. Each test owns its Studio instance and its
 * data roots, so suites are serialised per worker rather than sharing a server:
 * a single local host claims `host.lock` in its own root, and parallel workers
 * would otherwise fight over ports and CPU during `next dev` compilation.
 */
export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === "true" || process.env.CI === "1",
  retries: 0,
  // Booting the supervisor (migrate, seed, first compile) dominates a flow.
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  use: {
    trace: "retain-on-failure",
    video: "off",
    screenshot: "only-on-failure",
    actionTimeout: 60_000,
  },
  projects: [
    { name: "smoke", testMatch: ["smoke/**/*.spec.ts"] },
    {
      name: "maps",
      testMatch: ["flows/maps*.spec.ts", "flows/core-studio*.spec.ts"],
    },
    { name: "models", testMatch: ["flows/models*.spec.ts"] },
    {
      name: "interop",
      testMatch: [
        "flows/interop*.spec.ts",
        "flows/cli*.spec.ts",
        "flows/platform*.spec.ts",
        "flows/recovery-security*.spec.ts",
      ],
    },
  ],
});
