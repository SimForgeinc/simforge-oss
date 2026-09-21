import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { test } from "node:test";

import { migrate } from "../../../../scripts/migrate";
import { execute, shutdownDatabase } from "../../db/data-api";
import { liveCpuWorkers, noteLocalWorkerPresence } from "../jobs/local-native-render-store";

/**
 * Presence must survive the process that observed it: the claim poll writes a row, the
 * capabilities read (on any instance) sees it for as long as the liveness window lasts, and
 * a worker that stopped polling disappears instead of lingering as "attached".
 */
test("worker presence is durable, window-scoped and engine-filtered", async (t) => {
  t.after(() => shutdownDatabase());
  await migrate();

  await noteLocalWorkerPresence("worker-fresh", ["browser", "native"]);
  await noteLocalWorkerPresence("worker-stale", ["browser"]);
  await execute(
    `UPDATE simforge.cpu_worker_presence SET last_seen_at = NOW() - INTERVAL '10 minutes'
      WHERE worker_id = :worker_id`,
    { worker_id: "worker-stale" },
  );

  const live = await liveCpuWorkers();
  assert.deepEqual(live.map((worker) => worker.workerId), ["worker-fresh"]);
  assert.deepEqual([...live[0]!.engines], ["browser", "native"]);
  assert.match(live[0]!.lastSeenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // A wide enough window brings the stale worker back: liveness is the window, not a deletion.
  const wide = await liveCpuWorkers(30 * 60_000);
  assert.deepEqual(wide.map((worker) => worker.workerId), ["worker-fresh", "worker-stale"]);

  // A later poll rewrites the same row rather than accumulating history, and engines the
  // capability contract does not know are dropped rather than surfaced.
  await noteLocalWorkerPresence("worker-fresh", ["browser", "carla"]);
  const rewritten = await liveCpuWorkers();
  assert.equal(rewritten.length, 1);
  assert.deepEqual([...rewritten[0]!.engines], ["browser"]);
});
