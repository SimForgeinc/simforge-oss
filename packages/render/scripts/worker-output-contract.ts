/**
 * Frozen worker -> control plane output contract.
 *
 *   pnpm --filter @simforge-oss/render contract:check          # fail on any violation or stale snapshot
 *   pnpm --filter @simforge-oss/render contract:write          # rewrite the snapshot (refuses violations)
 *   pnpm --filter @simforge-oss/render contract:write --allow-removal   # acknowledge a removed optional key
 *   pnpm --filter @simforge-oss/render contract:write --existing-document <name>
 *       # start tracking a document the worker already sent before the snapshot
 *       # knew about it (not a new route, so older control planes accept it)
 *   pnpm --filter @simforge-oss/render contract:print          # the snapshot the code would produce, to stdout
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as workerControl from '../src/worker-control.js';
import {
  buildWorkerOutputContractSnapshot,
  controlFeatureConstants,
  workerOutputContractViolations,
  type WorkerOutputContractSnapshot,
} from '../src/contract/worker-output-contract.js';

const snapshotPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../contract/worker-output-contract.json');
const mode = process.argv[2] ?? '--check';
const allowRemoval = process.argv.includes('--allow-removal');
const existingDocuments = new Set(process.argv.flatMap((arg, i, all) => (arg === '--existing-document' ? [all[i + 1]] : [])));
const features = controlFeatureConstants(workerControl);

let previous: WorkerOutputContractSnapshot | null = null;
try { previous = JSON.parse(await readFile(snapshotPath, 'utf8')) as WorkerOutputContractSnapshot; } catch { previous = null; }

const violations = workerOutputContractViolations(previous, features)
  .filter((violation) => !(allowRemoval && violation.rule === 'baseline-key-removed'))
  .filter((violation) => !(violation.rule === 'new-required-route' && [...existingDocuments].some((name) => violation.message.includes(`'${name}'`))));
const next = buildWorkerOutputContractSnapshot(features, previous, { allowRemoval });
const serialized = `${JSON.stringify(next, null, 2)}\n`;

if (mode === '--print') {
  process.stdout.write(serialized);
} else {
  for (const violation of violations) console.error(`[${violation.rule}] ${violation.message}`);
  if (violations.length > 0) process.exit(1);
  if (mode === '--write') {
    await writeFile(snapshotPath, serialized);
    console.log(`wrote ${path.relative(process.cwd(), snapshotPath)}`);
  } else if (!previous || `${JSON.stringify(previous, null, 2)}\n` !== serialized) {
    console.error(`${snapshotPath} is stale: run \`pnpm --filter @simforge-oss/render contract:write\` and commit it.`);
    process.exit(1);
  } else {
    console.log('worker output contract: ok');
  }
}
