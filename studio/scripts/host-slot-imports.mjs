#!/usr/bin/env node
/**
 * Slots (host-slots.json) must be imported as `@/<path>`: the host replaces a
 * slot by resolving `@/*` to itself first, so a relative import would keep
 * this app's module in a hosted build. This checks that rule, and `--fix`
 * rewrites relative slot imports to the `@/` form.
 *
 * Usage: node scripts/host-slot-imports.mjs [--fix]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const studioDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fix = process.argv.includes("--fix");
const slots = JSON.parse(readFileSync(join(studioDir, "host-slots.json"), "utf8")).slots;
const slotIds = new Set(slots.map((slot) => slot.replace(/\.(tsx?|mjs|js)$/, "")));
// `worker/` and `desktop/` are processes of the local host only; no attached
// host runs them, so they keep their relative imports.
const SKIP = new Set(["node_modules", ".next", "public", "test-results", "dist", "worker", "desktop"]);
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*|\brequire\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".next") || entry.name === "(host)") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.(tsx?|mts|mjs)$/.test(entry.name)) yield path;
  }
}

const violations = [];
for (const file of sources(studioDir)) {
  const text = readFileSync(file, "utf8");
  const next = text.replace(SPECIFIER, (match, lead, quote, specifier) => {
    const target = normalize(join(dirname(relative(studioDir, file)), specifier))
      .replace(/\.(tsx?|mjs|js)$/, "")
      .replace(/\/index$/, "");
    const id = slotIds.has(target) ? target : slotIds.has(`${target}/index`) ? `${target}/index` : null;
    if (!id) return match;
    violations.push(`${relative(studioDir, file)}: ${specifier}`);
    return `${lead}${quote}@/${target}${quote}`;
  });
  if (fix && next !== text) writeFileSync(file, next);
}

if (violations.length > 0) {
  console.log(`${fix ? "rewrote" : "found"} ${violations.length} relative slot import(s):\n  ${violations.join("\n  ")}`);
  if (!fix) {
    console.error("Import host slots as @/<path> (run with --fix).");
    process.exit(1);
  }
}
