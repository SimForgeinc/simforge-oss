import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesAny } from "./lib/util.mjs";
import { affectedCrates } from "./lib/cargo.mjs";
import { underDir } from "./lib/layout.mjs";

test("globs: **, *, braces, negation, directory prefix", () => {
  assert.ok(matchesAny("packages/studio-ui/src/a/B.tsx", ["packages/studio-ui/src/**/*.{ts,tsx}"]));
  assert.ok(!matchesAny("packages/studio-ui/src/a/B.css", ["packages/studio-ui/src/**/*.{ts,tsx}"]));
  assert.ok(matchesAny("native/Cargo.lock", ["native/"]));
  assert.ok(!matchesAny("docs/x.md", ["**", "!**/*.md"]));
  assert.ok(matchesAny("a.json", ["*.json"]));
  assert.ok(!matchesAny("a/b.json", ["*.json"]));
});

const crates = [
  { name: "core", dir: "native/crates/core", pathDeps: [] },
  { name: "runner", dir: "native/crates/runner", pathDeps: ["native/crates/core"] },
  { name: "wasm", dir: "native/crates/wasm", pathDeps: ["native/crates/runner"] },
  { name: "other", dir: "native/crates/other", pathDeps: [] },
];

test("cargo: a changed crate pulls in its transitive dependents only", () => {
  assert.deepEqual(affectedCrates(crates, "native", ["native/crates/core/src/lib.rs"]), { all: false, crates: ["core", "runner", "wasm"] });
  assert.deepEqual(affectedCrates(crates, "native", ["native/crates/other/src/lib.rs"]), { all: false, crates: ["other"] });
});

test("cargo: workspace-level files select every crate; docs select none", () => {
  assert.equal(affectedCrates(crates, "native", ["native/Cargo.lock"]).all, true);
  assert.deepEqual(affectedCrates(crates, "native", ["native/README.md"]), { all: false, crates: [] });
});

test("layout: underDir re-roots paths for the monorepo", () => {
  const cfg = underDir(
    {
      checks: [{ name: "style", when: ["studio/app/**", "!studio/app/x.ts"], cwd: "." }],
      cargo: [{ name: "native", dir: "native" }],
      turbo: { global: ["pnpm-lock.yaml"], triggers: [{ when: ["native/crates/**"], packages: ["p"] }] },
      golden: { name: "golden", when: ["fixtures/**"], steps: [] },
      full: [],
    },
    "oss",
  );
  assert.deepEqual(cfg.checks[0].when, ["oss/studio/app/**", "!oss/studio/app/x.ts"]);
  assert.equal(cfg.checks[0].cwd, "oss");
  assert.equal(cfg.cargo[0].dir, "oss/native");
  assert.deepEqual(cfg.turbo.triggers[0].when, ["oss/native/crates/**"]);
  assert.deepEqual(cfg.golden.when, ["oss/fixtures/**"]);
});
