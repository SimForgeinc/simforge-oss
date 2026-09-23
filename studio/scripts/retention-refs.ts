import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retentionRefsDocument } from "../app/lib/db/retention-refs";
import { shutdownDatabase } from "../app/lib/db/data-api";

/**
 * Write the `simforge.retention-refs.v1` snapshot of this installation's
 * database (DATABASE_URL, or the local data root): every digest a map
 * version, revision, draft pin, simulation result or render job references.
 * `simforge maps prune --gc` refuses to run without one; generate it right
 * before the prune, it is only accepted while fresh.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @simforge-oss/studio retention:refs -- --out refs.json
 */
async function main(argv: readonly string[]): Promise<void> {
  let out: string | undefined;
  let source = `studio:${hostname()}`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") out = argv[++index];
    else if (arg === "--source") source = argv[++index] ?? source;
    else throw new Error(`unknown argument ${arg}; usage: retention-refs [--out <file>] [--source <label>]`);
  }
  const document = await retentionRefsDocument(source);
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (out) {
    await writeFile(out, text);
    console.error(`wrote ${document.digests.length} referenced digests to ${out}`);
  } else {
    process.stdout.write(text);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2).filter((arg) => arg !== "--"));
  } finally {
    await shutdownDatabase();
  }
}
