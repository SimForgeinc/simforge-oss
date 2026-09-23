/**
 * Child process for pglite-crash-safety.test.ts. SIMFORGE_CLOUD_ROOT is set by
 * the parent. `write` commits one row at a time and prints each committed
 * counter; `read` prints the highest committed counter and closes.
 */
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { execute, queryOne, shutdownDatabase } from "../../data-api";

const mode = process.argv[2];

if (mode === "write") {
  await execute("CREATE TABLE IF NOT EXISTS crash_probe (n integer PRIMARY KEY, payload text NOT NULL)");
  const start = (await queryOne<{ n: number | null }>("SELECT max(n) AS n FROM crash_probe"))?.n ?? 0;
  process.stdout.write("ready\n");
  for (let n = start + 1; ; n += 1) {
    // A few KB per row so checkpoints, WAL page boundaries and heap page
    // splits are all crossed while the parent waits to kill us.
    await execute("INSERT INTO crash_probe (n, payload) VALUES (:n, :payload)", { n, payload: `row-${n}-`.padEnd(3000, "x") });
    process.stdout.write(`committed ${n}\n`);
    // PGlite resolves on microtasks alone; a server yields to I/O between
    // requests, and so must this loop or signals are never delivered.
    await yieldToEventLoop();
  }
} else if (mode === "read") {
  const row = await queryOne<{ n: number | null; c: number }>("SELECT max(n) AS n, count(*)::int AS c FROM crash_probe");
  process.stdout.write(`${JSON.stringify({ max: row?.n ?? 0, count: row?.c ?? 0 })}\n`);
  await shutdownDatabase();
} else {
  throw new Error(`unknown mode ${mode}`);
}
