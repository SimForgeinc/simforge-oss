#!/usr/bin/env node
/**
 * Absolute Studio/Cloud URLs are built in exactly one place.
 *
 * `new URL(path, base)` resolves a path against an authority. Written with a
 * `string` base it is where a host origin and a Cloud origin get confused,
 * and where an invented authority (`http://127.0.0.1:<port>`, a production
 * default) turns into a URL a browser or a daemon actually contacts.
 * `packages/studio-host/src/origins.ts` owns that construction behind
 * `HostOrigin`/`CloudOrigin`, whose path types cannot cross. This check
 * fails on the two-argument form anywhere else in the host, CLI, worker and
 * shell trees. Bases that are not a network authority are exempt:
 * `import.meta.url` resolves files, `location`/`document.baseURI` is the
 * browser's own same-origin resolution, `request.url`/`req.url` is the
 * server's own view of the request being handled.
 *
 * The repository has no ESLint/Biome, so this is the lint rule, run by CI
 * next to `verify:naming`. It parses with the TypeScript compiler rather than
 * grepping, so formatting cannot hide a match.
 *
 * ALLOWED is the burn-down of sites that predate the origin module. Each
 * entry is a file and the number of matches it may still contain; the
 * migration deletes entries as it removes the `string` authorities. A count
 * below the allowance also fails, so the list cannot go stale.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ORIGIN_MODULE = "packages/studio-host/src/origins.ts";
const SCAN = [
  "packages/studio-host/src",
  "packages/cli/src",
  "studio/app",
  "studio/desktop",
  "studio/scripts",
  "studio/worker",
  "studio/proxy.ts",
];
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs"]);
const EXEMPT_BASE = /^(import\.meta\.url|(window\.|globalThis\.|self\.)?(location(\.(href|origin))?|document\.baseURI)|(request|req)\.url)$/;

/**
 * @type {Record<string, number>} matches still tolerated per file; removed by
 * the authority migration. The redirect-following sites (`new URL(location,
 * current)`) resolve a `Location` header against the URL just fetched and
 * stay; every other entry is an unbranded host or Cloud authority.
 */
const ALLOWED = {
  "packages/cli/src/commands/cloud-eval.ts": 1,
  "packages/cli/src/commands/render-jobs.ts": 1,
  "packages/cli/src/commands/scenario.ts": 2,
  "studio/app/lib/cloud/access.ts": 1,
  "studio/app/lib/cloud/connection.ts": 5,
  "studio/app/lib/cloud/storage.ts": 1,
  "studio/app/lib/map-cache/cache.ts": 2,
  "studio/app/lib/map-cache/transfer.ts": 1,
  "studio/app/lib/s3/s3-presign.ts": 1,
  "studio/app/lib/scenario/routes.ts": 1,
  "studio/desktop/map-cache.mjs": 2,
  "studio/desktop/update-check.mjs": 1,
  "studio/scripts/bootstrap-public-maps.ts": 1,
  "studio/worker/compiler.ts": 2,
  "studio/worker/http-client.ts": 1,
};

function* files(path) {
  const stat = statSync(path);
  if (stat.isFile()) {
    // Tests assert on URLs they built; the rule is about URLs handed to clients.
    if (EXTENSIONS.has(path.slice(path.lastIndexOf("."))) && !/\.test\.[cm]?[jt]sx?$/.test(path)) yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist" || entry.name === "__tests__") continue;
    yield* files(join(path, entry.name));
  }
}

/** @param {string} file */
function matches(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "URL"
      && node.arguments?.length === 2
      && !EXEMPT_BASE.test(node.arguments[1].getText(source))
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${relative(ROOT, file)}:${line + 1}: ${node.getText(source)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const list = process.argv.includes("--list");
/** @type {Record<string, string[]>} */
const byFile = {};
for (const root of SCAN) {
  for (const file of files(join(ROOT, root))) {
    const key = relative(ROOT, file);
    if (key === ORIGIN_MODULE) continue;
    const found = matches(file);
    if (found.length > 0) byFile[key] = found;
  }
}

if (list) {
  for (const found of Object.values(byFile)) for (const line of found) console.log(line);
  process.exit(0);
}

const failures = [];
for (const [file, found] of Object.entries(byFile)) {
  const allowed = ALLOWED[file] ?? 0;
  if (found.length > allowed) {
    failures.push(
      `${file}: ${found.length} two-argument new URL(path, base) call(s), ${allowed} allowed. Build absolute URLs with HostOrigin/CloudOrigin.toURL from @simforge-oss/studio-host.`,
      ...found.map((line) => `  ${line}`),
    );
  } else if (found.length < allowed) {
    failures.push(`${file}: ${found.length} call(s) remain but ${allowed} are allowed; lower its entry in scripts/verify-origin-urls.mjs.`);
  }
}
for (const file of Object.keys(ALLOWED)) {
  if (!(file in byFile)) failures.push(`${file}: no calls remain (or the file is gone); remove its entry from scripts/verify-origin-urls.mjs.`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`verify-origin-urls: no new absolute-URL construction outside ${ORIGIN_MODULE}`);
