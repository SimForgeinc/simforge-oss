// The layout adapter. Every repository that uses devflow has a
// `devflow.config.mjs` at its root describing where things live; the commands
// never hard-code paths. Three layouts are supported by the same code:
//
//   * simforge-oss on its own (today, and the public mirror after the cutover)
//   * simcloud-platform on its own (today: OSS arrives as vendored tarballs)
//   * the monorepo (after the cutover): simcloud-platform with SimForge in `oss/`.
//     Its root config imports `oss/devflow.config.mjs` and re-roots it with
//     `underDir(ossConfig, "oss")`, then adds its own steps.
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { sh } from "./util.mjs";

export function repoRoot(cwd = process.cwd()) {
  return sh("git", ["rev-parse", "--show-toplevel"], { cwd });
}

export async function loadLayout(root) {
  const file = join(root, "devflow.config.mjs");
  if (!existsSync(file)) {
    throw new Error(`No devflow.config.mjs at ${root}. This repository has not opted into devflow.`);
  }
  const config = (await import(pathToFileURL(file).href)).default;
  return normalize(config);
}

function normalize(config) {
  return {
    name: config.name,
    baseRefs: config.baseRefs ?? ["origin/main", "main"],
    packageManager: config.packageManager ?? (config.lockfile === "package-lock.json" ? "npm" : "pnpm"),
    turbo: config.turbo ?? null,
    checks: config.checks ?? [],
    cargo: config.cargo ?? [],
    golden: config.golden ?? null,
    full: config.full ?? [],
    remoteCache: config.remoteCache ?? null,
    env: config.env ?? null,
  };
}

const rebase = (dir, path) => (path === "." || path === "" ? dir : posix.join(dir, path));
const rebaseGlob = (dir, glob) => (glob.startsWith("!") ? `!${rebase(dir, glob.slice(1))}` : rebase(dir, glob));
const rebaseStep = (dir, step) => ({
  ...step,
  cwd: rebase(dir, step.cwd ?? "."),
  when: step.when?.map((glob) => rebaseGlob(dir, glob)),
  changedFilter: step.changedFilter?.map((glob) => rebaseGlob(dir, glob)),
  steps: step.steps?.map((s) => ({ ...s, cwd: rebase(dir, s.cwd ?? step.cwd ?? ".") })),
});

/**
 * Re-roots a sub-repository's config under `dir` so a parent repository can
 * compose it. Only paths move; commands, crate names and package names stay.
 */
export function underDir(config, dir) {
  return {
    ...config,
    checks: (config.checks ?? []).map((step) => rebaseStep(dir, step)),
    cargo: (config.cargo ?? []).map((ws) => ({ ...ws, dir: rebase(dir, ws.dir) })),
    golden: config.golden ? rebaseStep(dir, config.golden) : null,
    full: (config.full ?? []).map((step) => rebaseStep(dir, step)),
    turbo: config.turbo
      ? {
          ...config.turbo,
          triggers: (config.turbo.triggers ?? []).map((t) => ({ ...t, when: t.when.map((g) => rebaseGlob(dir, g)) })),
          global: (config.turbo.global ?? []).map((g) => rebaseGlob(dir, g)),
        }
      : null,
  };
}
