#!/usr/bin/env node
/**
 * `pnpm lint:style`: StyleX lint for Studio.
 *
 * The ESLint toolchain lives in `scripts/style/eslint` with its own lockfile,
 * installed here on first use (`--ignore-workspace`), so it never enters the
 * workspace install or its lockfile. Extra arguments go to ESLint, e.g. a
 * file path to lint just that file.
 *
 * Errors that predate a rule are held in `eslint/eslint-suppressions.json`
 * (ESLint's bulk suppressions): they are tolerated at their current count per
 * file and rule, and anything new fails. Fixing some of them makes ESLint ask
 * for `--prune-suppressions`, which shrinks the file; `--suppress-all` exists
 * for introducing a new rule and should not be used to admit new violations.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const toolDir = join(here, "eslint");
const repoRoot = join(here, "..", "..");

if (!existsSync(join(toolDir, "node_modules", "eslint", "package.json"))) {
  const install = spawnSync("pnpm", ["install", "--ignore-workspace", "--frozen-lockfile", "--reporter=silent"], {
    cwd: toolDir,
    stdio: "inherit",
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const passthrough = process.argv.slice(2);
const targets = passthrough.some((arg) => !arg.startsWith("-")) ? [] : ["packages/studio-ui/src", "studio/app"];
const result = spawnSync(
  process.execPath,
  [join(toolDir, "node_modules", "eslint", "bin", "eslint.js"), "-c", join(toolDir, "eslint.config.mjs"), "--no-warn-ignored", "--suppressions-location", join(toolDir, "eslint-suppressions.json"), ...passthrough, ...targets],
  { cwd: repoRoot, stdio: "inherit" },
);
process.exit(result.status ?? 1);
