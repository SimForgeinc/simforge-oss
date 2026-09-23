#!/usr/bin/env node
// Fails on any `process.env.NEXT_PUBLIC_*` outside app/lib/public-env.ts.
//
// Next.js inlines those reads at build time, which ties a build to one
// environment. Read public settings with `publicEnv("NEXT_PUBLIC_X")` from
// `@/app/lib/public-env` instead: served at runtime, so one build serves every
// environment it is deployed to.
//
//   node oss/scripts/check-public-env.mjs [--root <dir>]...   (default: oss/studio)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const roots = [];
for (let i = 0; i < args.length; i += 1) if (args[i] === "--root") roots.push(args[++i]);
if (roots.length === 0) roots.push(new URL("../studio", import.meta.url).pathname);

const SKIP_DIRS = new Set(["node_modules", ".next", ".next-cloud", ".studio", ".turbo", "dist", "out", "coverage", "desktop", "scripts", "e2e"]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const ALLOWED = /(?:^|\/)app\/lib\/public-env\.ts$/;
const PATTERN = /process\.env\.NEXT_PUBLIC_[A-Z0-9_]+|process\.env\[\s*["'`]NEXT_PUBLIC_/g;

const findings = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(path);
    } else if (SOURCE.test(name) && !/\.test\.|__tests__/.test(path) && !ALLOWED.test(path)) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/^\s*(?:\/\/|\*)/.test(line)) return;
        for (const match of line.matchAll(PATTERN)) findings.push(`${relative(process.cwd(), path)}:${index + 1}: ${match[0]}`);
      });
    }
  }
}
for (const root of roots) walk(root);
if (findings.length) {
  console.error("Build-time public env reads (they tie a build to one environment):");
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('Use publicEnv("NEXT_PUBLIC_X") from "@/app/lib/public-env" and read it where it is used, not at module load.');
  process.exit(1);
}
console.log(`check-public-env: no build-time NEXT_PUBLIC_ reads under ${roots.map((r) => relative(process.cwd(), r) || ".").join(", ")}`);
