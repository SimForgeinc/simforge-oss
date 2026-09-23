import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execute, executeScript, queryRows, shutdownDatabase } from "@/app/lib/db/data-api";
import { localOnlyReason, migrationHostKind, migrationsLedger } from "./migration-plan";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = resolve(appRoot, "migrations");

/**
 * Apply every migration this host is allowed to apply, in filename order.
 *
 * Two things vary by host and nothing else does: migrations marked
 * `-- simforge:local-only` are refused on a cloud host (see
 * {@link localOnlyReason}), and the ledger table is configurable so a host
 * that keeps its own `public.schema_migrations` does not collide with this
 * one (see {@link migrationsLedger}).
 */
export async function migrate(): Promise<string[]> {
  const ledger = migrationsLedger();
  const hostKind = migrationHostKind();
  await execute(`CREATE TABLE IF NOT EXISTS ${ledger} (
    id TEXT PRIMARY KEY,
    filename TEXT UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const appliedRows = await queryRows<{ filename: string }>(
    `SELECT COALESCE(filename, id) AS filename FROM ${ledger}`,
  );
  const applied = new Set(appliedRows.map((row) => row.filename));
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  const newlyApplied: string[] = [];

  for (const filename of filenames) {
    if (applied.has(filename)) continue;
    const sql = await readFile(resolve(migrationsDirectory, filename), "utf8");
    const localOnly = localOnlyReason(sql);
    if (localOnly && hostKind !== "local") {
      console.log(`skip ${filename}: local-only — ${localOnly}`);
      continue;
    }
    await executeScript(sql);
    await execute(
      `INSERT INTO ${ledger} (id, filename)
       VALUES (:filename, :filename)
       ON CONFLICT (id) DO UPDATE SET filename = EXCLUDED.filename`,
      { filename },
    );
    newlyApplied.push(filename);
    console.log(`applied ${filename}`);
  }
  return newlyApplied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await migrate();
  console.log("migrations complete");
  // Release PGlite before exiting so the next owner (the server) opens it cleanly.
  await shutdownDatabase();
}
