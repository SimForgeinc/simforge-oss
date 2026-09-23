import "../../models/__tests__/test-env";
process.env.SIMFORGE_LOCAL_HOST_TOKEN ??= "sim-retention-test-token";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { contentHash } from "@simforge-oss/engine";
import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import type { AppContext } from "@/app/lib/db/app-context";
import { execute, queryOne, shutdownDatabase } from "@/app/lib/db/data-api";
import { readLocalObjectSize } from "@/app/lib/s3/s3-object";
import { createScenarioDocument, createScenarioRevision } from "../document-store";
import { resolveDocumentSimulation } from "../document-simulation";
import { runSimulationRetention } from "../sim-retention";
import { readSimulationRecord, resolveSimulation, setSimulationExecutorForTests } from "../sim-result-store";
import { seedPinnedMap } from "./pinning-fixtures";
import { fakeAuthoritativeSimulation } from "./sim-fixtures";

/**
 * Retention by reachability: unreachable draft-cache results past 90 days go, with their requests,
 * timelines and objects; anything a version, pointer, render, draft or recent request names stays;
 * requests and verification events expire on their own TTLs; shared objects are never deleted.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LTAP = JSON.parse(readFileSync(join(HERE, "../../../../../examples/ltap-opposing.template.json"), "utf8")) as Record<string, unknown>;
const context = { userId: LOCAL_USER_ID, workspaceId: LOCAL_WORKSPACE_ID, organizationId: LOCAL_ORGANIZATION_ID } as AppContext;

function content(name: string): Record<string, unknown> {
  return { ...LTAP, meta: { ...(LTAP.meta as object), name } };
}

/** An authoritative result for `name` (a fresh simulation, not tied to any document). */
async function cacheResult(name: string): Promise<string> {
  const body = content(name);
  const status = await resolveSimulation({ workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID, canonicalContent: body, contentSha256: contentHash(body), mapVersionId: "usmapv_pin" }, { waitMs: 5_000 });
  assert.equal(status.state, "succeeded");
  if (status.state !== "succeeded") throw new Error("simulation failed");
  return status.result.simKey;
}

async function age(simKey: string, days: number): Promise<void> {
  await execute(`UPDATE simforge.sim_results SET created_at = NOW() - (:days * INTERVAL '1 day') WHERE sim_key = :sim_key`, { sim_key: simKey, days });
  await execute(
    `UPDATE simforge.sim_requests SET completed_at = NOW() - (:days * INTERVAL '1 day'), updated_at = NOW() - (:days * INTERVAL '1 day') WHERE sim_key = :sim_key`,
    { sim_key: simKey, days },
  );
}

const exists = async (simKey: string) => Boolean(await readSimulationRecord(LOCAL_WORKSPACE_ID, simKey));

before(async () => {
  await migrate();
  await seedPinnedMap();
  // Each subject gets its own trace (the seed is the content's name).
  setSimulationExecutorForTests(async (subject) => fakeAuthoritativeSimulation(String((subject.canonicalContent as { meta: { name: string } }).meta.name), { assetId: "map-pin", versionId: "usmapv_pin" }));
});

after(async () => {
  setSimulationExecutorForTests(null);
  await shutdownDatabase();
});

test("unreachable draft cache past 90 days is deleted; everything a user can reach stays", async () => {
  // 1. Pure cache, old: collectable.
  const orphan = await cacheResult("orphan-old");
  await age(orphan, 120);
  // 2. Pure cache, recent: kept until it is 90 days old.
  const recent = await cacheResult("orphan-recent");
  await age(recent, 10);
  // 3. The result a draft last showed: kept however old.
  const doc = await createScenarioDocument(context, { title: "Draft shows", schemaVersion: "2", content: parseTemplate(content("draft-shows")) as ScenarioTemplateV2, mapVersionId: "usmapv_pin", datasetId: "usds_pin", authoringQualityId: "medium" });
  const shown = await resolveDocumentSimulation(context, doc.id, { expectedVersion: doc.draftVersion, waitMs: 5_000 });
  assert.ok(shown.kind === "status" && shown.status.state === "succeeded");
  const draftResult = shown.status.state === "succeeded" ? shown.status.result.simKey : "";
  await age(draftResult, 400);
  // 4. A version's simulation: kept.
  const versioned = await createScenarioDocument(context, { title: "Versioned", schemaVersion: "2", content: parseTemplate(content("versioned")) as ScenarioTemplateV2, mapVersionId: "usmapv_pin", datasetId: "usds_pin", authoringQualityId: "medium" });
  const revision = await createScenarioRevision(context, versioned.id, { expectedVersion: versioned.draftVersion });
  assert.equal(revision.kind, "created");
  const revisionResult = (await queryOne<{ sim_key: string }>(`SELECT sim_key FROM simforge.revision_active_simulation WHERE revision_id = :id`, { id: revision.kind === "created" ? revision.revision.id : "" }))!.sim_key;
  await age(revisionResult, 400);
  // 5. Telemetry and a stale request.
  await execute(
    `INSERT INTO simforge.sim_verification_events (id, workspace_id, sim_key, outcome, local_trace_sha256, authoritative_trace_sha256, created_at)
     VALUES ('ussv_old', :ws, :sim, 'verified', :sha, :sha, NOW() - INTERVAL '100 days'),
            ('ussv_new', :ws, :sim, 'verified', :sha, :sha, NOW() - INTERVAL '5 days')`,
    { ws: LOCAL_WORKSPACE_ID, sim: draftResult, sha: "a".repeat(64) },
  );
  const orphanRecord = (await readSimulationRecord(LOCAL_WORKSPACE_ID, orphan))!;

  const dry = await runSimulationRetention({ apply: false });
  assert.deepEqual(dry.results.map((row) => row.simKey), [orphan], "only the old, unreachable result is planned");
  assert.equal(dry.verificationEvents, 1);
  assert.ok(await exists(orphan), "a dry run changes nothing");

  const applied = await runSimulationRetention({ apply: true });
  assert.deepEqual(applied.results.map((row) => row.simKey), [orphan]);
  assert.equal(await exists(orphan), false);
  for (const kept of [recent, draftResult, revisionResult]) assert.equal(await exists(kept), true);
  assert.equal(await readLocalObjectSize(orphanRecord.storage_bucket, orphanRecord.trace_storage_key), null, "its trace object is gone");
  const events = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM simforge.sim_verification_events`);
  assert.equal(Number(events?.n), 1, "old telemetry expired, recent kept");
  const orphanRequests = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM simforge.sim_requests WHERE sim_key = :sim`, { sim: orphan });
  assert.equal(Number(orphanRequests?.n), 0);
});

test("an object another result still names is never deleted", async () => {
  // Two results with byte-identical traces (the same motion under two keys) share one object.
  const a = await cacheResult("shared-trace");
  const recordA = (await readSimulationRecord(LOCAL_WORKSPACE_ID, a))!;
  const other = content("shared-trace-twin");
  await execute(
    `INSERT INTO simforge.sim_results (workspace_id, sim_key, trace_sha256, authored_trace_sha256, engine_sem_ver, solver_ver, trace_schema,
       resolved_input_digest, map_closure_digest, traffic_provider, map_version_id, producer, storage_bucket, trace_storage_key,
       trace_byte_length, trace_gzip_sha256, resolution_storage_key, resolution_byte_length, resolution_sha256)
     SELECT workspace_id, :twin, trace_sha256, authored_trace_sha256, '0.11.0', '0.11.0', trace_schema, resolved_input_digest,
       map_closure_digest, traffic_provider, map_version_id, producer, storage_bucket, trace_storage_key, trace_byte_length,
       trace_gzip_sha256, resolution_storage_key, resolution_byte_length, resolution_sha256
       FROM simforge.sim_results WHERE sim_key = :a`,
    { twin: contentHash(other).slice(0, 64), a },
  );
  await age(a, 200);
  const applied = await runSimulationRetention({ apply: true });
  assert.ok(applied.results.some((row) => row.simKey === a));
  assert.equal(applied.objects.some((object) => object.key === recordA.trace_storage_key), false);
  assert.notEqual(await readLocalObjectSize(recordA.storage_bucket, recordA.trace_storage_key), null, "the twin still replays it");
});
