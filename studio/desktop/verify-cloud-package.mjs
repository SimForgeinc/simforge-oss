#!/usr/bin/env node
// Checks every packaged SimCloud application under dist/desktop-cloud/out:
//
//   node desktop/verify-cloud-package.mjs [--origin=https://simforge.ai]
//
// For each app.asar electron-builder produced (win-unpacked, linux-unpacked,
// mac*/SimCloud.app), the archive must hold exactly the staged shell files
// (no collected workspace node_modules), the shell must carry the expected
// origin, and the package must ship no local-runtime resources: no
// resources/studio stage, no native addon, no runtime archive. This is the
// "slim, no Linux binaries" guarantee the Windows/macOS artifacts rest on.

import { createRequire } from "node:module";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_PRELOAD, DEFAULT_CLOUD_ORIGIN } from "./stage-app.mjs";

const require = createRequire(import.meta.url);
// @electron/asar is a dependency of electron-builder's app-builder-lib, not of studio.
const asar = createRequire(require.resolve("app-builder-lib/package.json"))("@electron/asar");

const desktopDir = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(desktopDir, "..", "dist", "desktop-cloud", "out");
const origin = process.argv.find((arg) => arg.startsWith("--origin="))?.slice("--origin=".length) ?? DEFAULT_CLOUD_ORIGIN;

const EXPECTED = ["main.mjs", CACHE_PRELOAD, "starting.html", "unreachable.html", "package.json"].sort();
const FORBIDDEN = [/(^|[\\/])studio[\\/]stage-manifest\.json$/, /\.node$/, /simforge-native-runtime/, /[\\/]node_modules[\\/]/];

const problems = [];
const entries = await readdir(outDir, { recursive: true }).catch(() => {
  problems.push(`${outDir} does not exist; run electron-builder with desktop/electron-builder.cloud.yml first`);
  return [];
});
const archives = entries.filter((entry) => entry.endsWith("app.asar") && !entry.endsWith(".asar.unpacked"));
if (archives.length === 0 && problems.length === 0) problems.push(`no app.asar under ${outDir}`);

for (const rel of archives) {
  const archive = join(outDir, rel);
  const packageRoot = rel.split(sep)[0];
  const listed = asar.listPackage(archive, { isPack: false })
    .map((entry) => entry.replace(/^[\\/]/, ""))
    .filter((entry) => entry.length > 0)
    .sort();
  if (listed.join("\n") !== EXPECTED.join("\n")) {
    problems.push(`${rel}: app.asar holds [${listed.join(", ")}], expected [${EXPECTED.join(", ")}]`);
  }
  const main = asar.extractFile(archive, "main.mjs").toString("utf8");
  if (!main.includes(JSON.stringify(origin))) problems.push(`${rel}: main.mjs does not carry the origin ${origin}`);
  if (main.includes("local-host.mjs") || main.includes("readLocalHostState")) problems.push(`${rel}: main.mjs bundles the local host`);

  const packageEntries = entries.filter((entry) => entry.split(sep)[0] === packageRoot);
  for (const entry of packageEntries) {
    if (FORBIDDEN.some((pattern) => pattern.test(entry))) problems.push(`${rel}: package ships local-runtime content ${entry}`);
  }
  const resourcesDir = dirname(archive);
  const stage = await stat(join(resourcesDir, "studio")).catch(() => null);
  if (stage) problems.push(`${rel}: ${relative(outDir, join(resourcesDir, "studio"))} is a local host stage`);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ component: "simforge-desktop-stage", event: "verify-cloud-package.ok", archives, origin })}\n`);
