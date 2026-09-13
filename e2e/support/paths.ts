import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `<repo>/e2e` — this harness. */
export const E2E_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The repository root; every other path is derived from it. */
export const REPO_ROOT = resolve(E2E_ROOT, "..");
export const STUDIO_ROOT = resolve(REPO_ROOT, "studio");
/** The `simforge` CLI entry point `runCli` executes, and the build output it loads. */
export const CLI_BIN = resolve(REPO_ROOT, "packages", "cli", "bin", "simforge.js");
export const CLI_DIST = resolve(REPO_ROOT, "packages", "cli", "dist", "main.js");
/** Deterministic fixture payloads, served by `startFixtureServer`. */
export const FIXTURES_DIR = resolve(E2E_ROOT, "fixtures");
/** Structured evidence, one directory per run. */
export const EVIDENCE_DIR = resolve(E2E_ROOT, "evidence");
export const REPORT_DIR = resolve(E2E_ROOT, "playwright-report");
export const RESULTS_DIR = resolve(E2E_ROOT, "test-results");
