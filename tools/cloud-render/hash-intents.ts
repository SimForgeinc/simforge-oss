/**
 * Print `hashRenderIntent` for each intent in a JSON array, using this repo's
 * schema — the same code the render worker runs.
 *
 * Dev's deployed plane bundles an older `@simforge-oss/scenario` whose lidar
 * attributes lack the `horizontalFovDeg` default. It therefore stored a digest
 * taken over bytes without that field, then served the field once its own
 * parse filled it in, and the worker correctly refused the difference. The
 * submission endpoint rejects the field outright, so it cannot be supplied by
 * hand. Recomputing the digest with the worker's schema is what makes the two
 * sides agree until dev redeploys.
 */
import { readFileSync } from 'node:fs';
import { hashRenderIntent } from '../../packages/scenario/src/index';

const rows = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Array<{ id: string; intent: unknown }>;
console.log(JSON.stringify(rows.map((row) => ({ id: row.id, sha256: hashRenderIntent(row.intent as never) }))));
