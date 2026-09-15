/**
 * Defect class 5 — a prebuilt artifact whose ABI did not match the code.
 *
 * The shipped wasm blob reported binding ABI 2 while the package required
 * ABI 3, so every page that mounted the native runtime failed. The artifact
 * was stale: the source and the loader agreed with each other perfectly, and
 * the only disagreement was with a binary nobody re-ran. A unit test cannot
 * see this, because a unit test does not load the shipped blob — it loads a
 * mock, or it loads nothing.
 *
 * The four assertions here sit at four different layers, because the defect
 * can enter at any of them:
 *   1. the shipped wasm reports the ABI the code requires — the stale build,
 *      which is what actually happened;
 *   2. the shipped Node addon does the same;
 *   3. the Rust constant and the TypeScript constant agree — the drift that
 *      produces a stale build one commit later;
 *   4. the loader really refuses a mismatch — the enforcement, without which
 *      the first three are only documentation.
 *
 * `NativeRenderDistribution` enforces the same contract at install time; this
 * asserts it on the artifacts that ship.
 */

import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { assertNativeAbi } from "../../packages/native-runtime/src/index";
import { abiVersion as wasmAbiVersion, initSync as wasmInitSync } from "../../packages/native-runtime/wasm/simforge_native_runtime.js";
import { REPO_ROOT } from "../support/paths";
import { expect, test } from "../support/fixtures";

const NATIVE_RUNTIME = join(REPO_ROOT, "packages", "native-runtime");

/** The ABI the TypeScript package is typed against, read from its source. */
async function requiredAbiVersion(): Promise<number> {
  const source = await readFile(join(NATIVE_RUNTIME, "src", "shared.ts"), "utf8");
  const declared = /export const ABI_VERSION = (\d+)/.exec(source);
  expect(declared, "ABI_VERSION is declared in packages/native-runtime/src/shared.ts").not.toBeNull();
  return Number(declared![1]);
}

test.describe("the native runtime's reported ABI matches what the code requires", () => {
  test("the prebuilt wasm module reports the required ABI", async () => {
    const required = await requiredAbiVersion();
    const blob = join(NATIVE_RUNTIME, "wasm", "simforge_native_runtime_bg.wasm");
    wasmInitSync({ module: await readFile(blob) });
    // Read out of the instantiated module, not out of a manifest or a
    // filename: a version recorded *beside* an artifact is exactly what went
    // stale. Only the blob's own answer is evidence about the blob.
    expect(wasmAbiVersion(), `${blob} reports its binding ABI`).toBe(required);
  });

  test("the prebuilt Node addon reports the required ABI", async () => {
    const required = await requiredAbiVersion();
    const addonDir = join(NATIVE_RUNTIME, "native");
    const addons = (await readdir(addonDir)).filter((name) => name.endsWith(".node"));
    // One built addon for this platform must exist. Zero means the staging
    // step produced nothing, which is its own silent failure — the product
    // then falls back to the browser engine and never says why.
    expect(addons, `built addons in ${addonDir}`).not.toEqual([]);
    // A native addon's filename encodes platform and libc and only exists on
    // the machine that built it, so the specifier is genuinely discovered at
    // runtime and cannot be a static import.
    const require = createRequire(import.meta.url);
    for (const addon of addons) {
      const loaded = require(join(addonDir, addon)) as { abiVersion: () => number };
      expect(loaded.abiVersion(), `${addon} reports its binding ABI`).toBe(required);
    }
  });

  test("the Rust binding constant and the TypeScript constant are the same number", async () => {
    const required = await requiredAbiVersion();
    const rust = await readFile(
      join(REPO_ROOT, "native", "crates", "simforge-bindings-common", "src", "lib.rs"),
      "utf8",
    );
    const declared = /pub const ABI_VERSION: u32 = (\d+)/.exec(rust);
    expect(declared, "ABI_VERSION is declared in simforge-bindings-common").not.toBeNull();
    // These two are bumped together by hand. When they diverge, the next
    // build produces precisely the stale artifact this file exists for, so
    // catching the divergence is cheaper than catching its consequence.
    expect(Number(declared![1]), "the Rust ABI_VERSION").toBe(required);
  });

  test("the loader refuses a module whose ABI does not match", async () => {
    const required = await requiredAbiVersion();
    // The enforcement itself. If someone downgrades this to a warning — the
    // tempting change when a mismatch blocks a release — every assertion
    // above keeps passing while the product silently runs a foreign ABI.
    expect(() => assertNativeAbi({ abiVersion: () => required + 1 }, "a newer build")).toThrow(/binding ABI/);
    expect(() => assertNativeAbi({ abiVersion: () => required - 1 }, "an older build")).toThrow(/binding ABI/);
    expect(() => assertNativeAbi({}, "a module with no version export")).toThrow(/abiVersion/);
    // And it must accept the ABI it requires, or the check is vacuous and
    // the three assertions above prove nothing about the real loader.
    expect(() => assertNativeAbi({ abiVersion: () => required }, "a matching build")).not.toThrow();
  });
});
