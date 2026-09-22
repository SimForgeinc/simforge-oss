import { PG_URL } from "./pg-env";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../../auth/session";
import type { AppContext } from "../../../db/app-context";
import { queryOne, shutdownDatabase } from "../../../db/data-api";
import { createScenarioDocument } from "../../document-store";
import { seedPinnedMap } from "../pinning-fixtures";

/**
 * `createScenarioRevision` used to read the draft without a lock and allocate
 * `MAX(revision_number) + 1`: concurrent commits of one draft version all saw
 * "no revision yet", all computed the same number, and every one but the first
 * failed on a unique key (a bare 500). With the document and draft locked FOR
 * UPDATE for the whole commit, they serialize: one revision is created and the
 * others return it.
 *
 * PGlite has one connection and cannot show this, so the test needs a real
 * server:
 *
 *   SIMFORGE_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55437/race \
 *   node --conditions=development --conditions=react-server --import tsx \
 *     --test app/lib/scenario/__tests__/pg/revision-race.pg.test.ts
 */
const context = { userId: LOCAL_USER_ID, workspaceId: LOCAL_WORKSPACE_ID, organizationId: LOCAL_ORGANIZATION_ID } as AppContext;
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "commit-worker.ts");
const run = promisify(execFile);

/** Each commit in its own process: the in-process data layer serializes, a fleet of hosts does not. */
async function commitInOwnProcess(documentId: string, version: number, goAt: number): Promise<{ kind: string; revisionId?: string | null; message?: string }> {
  const { stdout } = await run(process.execPath, [
    "--conditions=development", "--conditions=react-server", "--import", "tsx", WORKER, documentId, String(version), String(goAt),
  ], { env: process.env, cwd: process.cwd() });
  return JSON.parse(stdout) as { kind: string; revisionId?: string | null; message?: string };
}

test("concurrent commits of one draft create one revision", { skip: PG_URL ? false : "SIMFORGE_TEST_DATABASE_URL is not set" }, async (t) => {
  t.after(() => shutdownDatabase());
  const { migrate } = await import("../../../../../scripts/migrate");
  await migrate();
  await seedPinnedMap();
  const created = await createScenarioDocument(context, {
    title: "race",
    schemaVersion: "simforge.scenario/v2",
    content: parseTemplate({
      scenarioVersion: 2,
      meta: { name: "race", createdAt: "2026-01-01T00:00:00.000Z", modifiedAt: "2026-01-01T00:00:00.000Z", appVersion: "test" },
      anchor: { features: [] },
    }) as ScenarioTemplateV2,
    mapVersionId: "usmapv_pin",
    datasetId: "usds_pin",
    authoringQualityId: "medium",
  });
  const goAt = Date.now() + 8_000;
  const results = await Promise.all(Array.from({ length: 6 }, () => commitInOwnProcess(created.id, created.draftVersion, goAt)));
  assert.deepEqual(results.filter((result) => result.kind !== "created"), []);
  const ids = new Set(results.map((result) => result.revisionId));
  assert.equal(ids.size, 1);
  const count = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM simforge.revisions WHERE document_id = :id`, { id: created.id });
  assert.equal(Number(count?.n), 1);
});
