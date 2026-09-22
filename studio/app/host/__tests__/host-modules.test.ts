import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The host-module boundary, enforced.
 *
 * `app/host/local/*` and `app/host/cloud/*` are the two halves of one seam: a
 * hosted deployment replaces `app/host/index.ts`, and the other half's modules
 * then never enter its build. A page that reaches past the barrel into one half
 * silently defeats that — the module is imported, its bundle is emitted, and
 * the surface the cloud host is supposed not to have comes back.
 *
 * The parity assertion is the other half of the same contract: a name one host
 * exports and the other does not is a page that compiles here and fails to
 * resolve there, which nothing else in this repository would catch, because
 * OSS only ever type-checks the local set.
 *
 * Both checks read source rather than importing it: these are client modules
 * whose transitive imports assume a bundler and a browser.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hostRoot = path.join(appRoot, "host");

test("no module imports a host half it must not reach", async () => {
  const entries = await readdir(appRoot, { withFileTypes: true, recursive: true });
  const outsiders: string[] = [];
  const crossings: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const from = path.relative(appRoot, file);
    // The guard's own directory reads both halves to compare them.
    if (from.startsWith(path.join("host", "__tests__"))) continue;
    // The barrel is the file whose whole job is to name the active half.
    if (from === path.join("host", "index.ts")) continue;
    const half = /^host[/\\](local|cloud)([/\\]|$)/.exec(from)?.[1] ?? null;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      const resolved = specifier.startsWith(".")
        ? path.relative(appRoot, path.resolve(path.dirname(file), specifier))
        : specifier.replace(/^@\/app\//, "");
      const target = /^host[/\\](local|cloud)([/\\]|$)/.exec(resolved)?.[1] ?? null;
      if (target === null) continue;
      const edge = `${from} -> ${specifier}`;
      // A half may import itself. `host/index.ts` names the active one, and
      // nothing else — not the other half's modules, not a page, not a lib.
      if (half === target) continue;
      if (half === null) outsiders.push(edge);
      else crossings.push(edge);
    }
  }
  assert.deepEqual(
    outsiders,
    [],
    `Import the active set from "@/app/host" instead:\n${outsiders.join("\n")}`,
  );
  assert.deepEqual(
    crossings,
    [],
    `A host half must never reach the other half; that is the leak:\n${crossings.join("\n")}`,
  );
});

test("both hosts offer the same surfaces", async () => {
  const [local, cloud] = await Promise.all([
    readFile(path.join(hostRoot, "local/index.ts"), "utf8"),
    readFile(path.join(hostRoot, "cloud/index.ts"), "utf8"),
  ]);
  const exported = (source: string) =>
    [...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1]!).sort();
  assert.notEqual(exported(local).length, 0);
  assert.deepEqual(exported(local), exported(cloud));
});
