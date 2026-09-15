import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Load machine-local E2E defaults without putting credentials in the
 * repository. Explicit process environment values always win, which keeps CI
 * and one-off runs authoritative.
 */
function loadLocalE2eEnv() {
  const configuredPath = process.env.SIMFORGE_E2E_ENV_FILE?.trim();
  const path = configuredPath
    ? (isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath))
    : join(homedir(), ".config", "simforge", "e2e-qa.env");
  if (!existsSync(path)) return;
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`Refusing insecure E2E env file permissions: ${path} (expected owner-only access)`);
  }
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

loadLocalE2eEnv();
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
    /**
     * Source-level defect guards. No host, no browser, seconds to run: they
     * read the App Router's route table and the product's own sources and
     * assert the two agree. Cheap enough to run on every change, and the
     * first thing to run when a navigation or a handler goes missing.
     */
    { name: "defects", testMatch: ["defects/**/*.spec.ts"] },
    /**
     * Defect guards that need the real server: one Studio host, no browser.
     * Separated from `defects` because a `next dev` host costs minutes and
     * gigabytes, and separated from the real-stack projects below because it
     * needs no cloud account and no GPU.
     */
    { name: "defects-live", testMatch: ["defects-live/**/*.spec.ts"] },
    /**
     * Real-stack coverage, one project per resource it consumes so a run can
     * ask for exactly what the machine can afford:
     * - `real-cloud`  a real SimCloud environment and a throwaway account
     * - `real-world`  a host, a browser and a working GPU
     * - `real-render` the above plus a render engine; tens of minutes
     * - `real-corpus` the above plus a migrated production corpus on dev
     */
    { name: "real-cloud", testMatch: ["real/cloud-*.spec.ts"] },
    { name: "real-world", testMatch: ["real/world-*.spec.ts"] },
    { name: "real-render", testMatch: ["real/render-*.spec.ts"] },
    { name: "real-corpus", testMatch: ["real/corpus-*.spec.ts"] },
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
