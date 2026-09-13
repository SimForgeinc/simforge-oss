#!/usr/bin/env node
/**
 * Execute the BUILT bundle. Nothing here tests behaviour; it tests that the
 * artifact loads and that its schemas can be constructed and used.
 *
 * This exists because a whole class of defect is invisible to both `tsc` and
 * every test that imports `src/`: a module that uses a value it only
 * RE-EXPORTS. `export * from './params.js'` satisfies the type checker and the
 * source graph, so `code: z.enum(REFUSAL_CODES)` typechecks, tests pass, and
 * the bundle throws `ReferenceError: REFUSAL_CODES is not defined` at module
 * load — after a cold start, on a customer's GPU, before any inference. That
 * happened, on an H100, and it cost a real job.
 *
 * It is deliberately not a vitest file: vitest resolves `src/`, which is the
 * environment that cannot see the bug. Run it after `build`, on the same
 * artifact that ships.
 */

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.resolve(HERE, '..', 'dist');

if (!existsSync(DIST)) {
  console.error('smoke-dist: dist/ does not exist; run the build first');
  process.exit(2);
}

const failures = [];

/** Load every built entry point. A module-scope ReferenceError surfaces here. */
const entries = readdirSync(DIST, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.map'))
  .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
  // CLI entry points run on import; exercise them through the barrels instead.
  .filter((file) => !/-cli\.js$|\/bin\.js$|chunk-/.test(file));

const loaded = new Map();
for (const file of entries) {
  try {
    loaded.set(file, await import(pathToFileURL(file).href));
  } catch (error) {
    failures.push(`load ${path.relative(DIST, file)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Construct and USE the schemas the workers parse with. A lazily-referenced
 * value inside a zod builder only throws when the builder runs, so importing
 * the module is not enough — the schema has to be exercised.
 */
const protocol = loaded.get(path.join(DIST, 'protocol', 'index.js'));
if (!protocol) {
  failures.push('protocol/index.js did not load; cannot exercise schemas');
} else {
  const checks = [
    ['OpenloopParamsSchema', () => protocol.OpenloopParamsSchema.safeParse({ items: [{ ref: 'x' }] })],
    ['PolicyEpisodeParamsSchema', () => protocol.PolicyEpisodeParamsSchema.safeParse({ spec: 'x' })],
    ['ComputeJobInputSchema', () => protocol.ComputeJobInputSchema.safeParse({})],
    ['ResultManifestSchema', () => protocol.ResultManifestSchema.safeParse({})],
    ['OpenloopInputSchema', () => protocol.OpenloopInputSchema.safeParse({ kind: 'user-clip' })],
    ['ObservationBundleSchema', () => protocol.ObservationBundleSchema.safeParse({})],
  ];
  for (const [name, run] of checks) {
    if (typeof protocol[name] === 'undefined') {
      // A schema this script names but the barrel does not export is a drift
      // between the two, which is worth failing on: the workers parse with
      // these, so a rename that misses one is the same class of break.
      failures.push(`protocol/index.js does not export ${name}`);
      continue;
    }
    try {
      run();
    } catch (error) {
      // A ReferenceError here is the exact defect this script exists for.
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`smoke-dist: ${String(failures.length)} failure(s) in the BUILT artifact`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`smoke-dist: ok (${String(loaded.size)} modules loaded, schemas constructed and parsed)`);
// Exit explicitly: the loaded bundle can hold handles (and this box aborts at
// GC-on-exit after loading the full graph), and a CI gate needs the status to
// mean the check's verdict rather than the teardown's.
process.exit(0);
