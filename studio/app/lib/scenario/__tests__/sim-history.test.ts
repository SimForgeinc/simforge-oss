import "../../models/__tests__/test-env";
// Authoritative traces are stored as local objects, signed with the supervised host's token.
process.env.SIMFORGE_LOCAL_HOST_TOKEN ??= "sim-history-test-token";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  gzipTrace,
  materializeTraceTraffic,
  simKey as computeSimKey,
  TRACE_SCHEMA,
  type AuthoritativeSimulation,
} from "@simforge-oss/compiler/node";
import { contentHash } from "@simforge-oss/engine";
import { runSimulation, traceDigest } from "@simforge-oss/engine/node";
import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { ScenarioMapResolutionError } from "@simforge-oss/studio-host";

import { migrate } from "../../../../scripts/migrate";
import { GalleryCatalogResolutionError, requireGalleryCatalogEntries, resolveGalleryCatalogIds } from "../../asset-gallery/store";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import type { AppContext } from "@/app/lib/db/app-context";
import { execute, queryOne, queryRows, shutdownDatabase, withTransaction } from "@/app/lib/db/data-api";
import { createScenarioDocument, createScenarioRevision } from "../document-store";
import { resolveDocumentSimulation } from "../document-simulation";
import {
  acceptDraftSimulation,
  compareSimulations,
  draftMapPinStatus,
  keepPreviousMotion,
  listDocumentVersions,
  readVersionContent,
  resimulateVersion,
  saveDraftVersion,
  selectVersionSimulation,
  simulationMotionDiff,
} from "../sim-history";
import { resolveSimulation, setSimulationExecutorForTests } from "../sim-result-store";
import { seedPinnedMap, setMembers, SIMULATION_MEMBERS } from "./pinning-fixtures";
import {
  LANE_LEFT,
  scenario,
  syntheticGraph,
  vehicle,
} from "../../../../../packages/engine/src/__tests__/fixtures/scenarios";

/**
 * Simulation history (migration 20260923120000 + sim-history.ts): append-only history rows, the
 * draft's last result and the engine-change banner, keeping the old motion as a version, rollback
 * by moving the active pointer, exact gallery versions, and drafts simulating on their pinned map.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LTAP = JSON.parse(readFileSync(join(HERE, "../../../../../examples/ltap-opposing.template.json"), "utf8")) as Record<string, unknown>;
const context = { userId: LOCAL_USER_ID, workspaceId: LOCAL_WORKSPACE_ID, organizationId: LOCAL_ORGANIZATION_ID } as AppContext;
const graph = syntheticGraph();

/** A real one-car simulation; `engineSemVer` and `speed` stand in for two engine versions. */
function simulation(seed: string, options: { engineSemVer: string; speed: number }): AuthoritativeSimulation {
  const input = scenario({
    seed,
    actors: [vehicle(graph, { id: "ego", rsl: LANE_LEFT, s: 60, speedMps: options.speed, cruiseSpeedMps: options.speed })],
  });
  const result = runSimulation(input, { graph });
  const resolvedInputDigest = contentHash(result.input);
  const traceSha256 = traceDigest(result.trace);
  const traceGzip = gzipTrace(result.trace);
  const mapClosureDigest = "e".repeat(64);
  return {
    simKey: computeSimKey({ resolvedInputDigest, mapClosureDigest, engineSemVer: options.engineSemVer, solverVer: options.engineSemVer, traceSchema: TRACE_SCHEMA }),
    traceSha256,
    authoredTraceSha256: traceSha256,
    trafficStepKey: null,
    resolvedInputDigest,
    mapClosureDigest,
    engineSemVer: options.engineSemVer,
    solverVer: options.engineSemVer,
    traceSchema: TRACE_SCHEMA,
    engineBuild: { engineVersion: options.engineSemVer },
    provider: "off",
    resolved: {
      template: {} as never,
      axisUntilClamps: [],
      concrete: { input: result.input, siteId: "site", materialization: {}, ambientTraffic: { actors: [] } as never },
      resolvedInput: result.input,
      executedInput: result.input,
    },
    trace: result.trace,
    traceGzip,
    traceGzipSha256: createHash("sha256").update(traceGzip).digest("hex"),
    traffic: materializeTraceTraffic({
      provider: "off",
      profile: {} as never,
      sourceInputDigest: resolvedInputDigest,
      map: { assetId: "map-pin", versionId: "usmapv_pin" },
      trace: result.trace,
      ambientActorIds: [],
    }),
    simulateMs: 1,
  };
}

/** Which simulation the inline executor produces next ("the engine this host runs"). */
let engine = { engineSemVer: "0.10.0", speed: 10 };
const SIM_CURRENT = { engineSemVer: "0.10.0", speed: 10 };
const SIM_OLD = { engineSemVer: "0.9.0", speed: 12 };

async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? `${error.message} ${(error as { detail?: string }).detail ?? ""}` : String(error);
  }
  assert.fail("expected a rejection");
}

async function newDocument(title: string): Promise<{ id: string; draftVersion: number }> {
  const created = await createScenarioDocument(context, {
    title,
    schemaVersion: "2",
    content: parseTemplate({ ...LTAP, meta: { ...(LTAP.meta as object), name: title } }) as ScenarioTemplateV2,
    mapVersionId: "usmapv_pin",
    datasetId: "usds_pin",
    authoringQualityId: "medium",
  });
  return { id: created.id, draftVersion: created.draftVersion };
}

/**
 * A result under the OLD engine that the draft "last showed": simulated for a sibling content (the
 * request memo is keyed by this host's engine, so the old engine's result is produced for another
 * subject), then recorded as the draft's last result, exactly as an rc.73 host would have left it.
 */
async function oldEngineResultFor(documentId: string, draftVersion: number, old = SIM_OLD): Promise<string> {
  engine = old;
  const content = { ...LTAP, meta: { ...(LTAP.meta as object), name: `old-engine-${documentId}` } };
  const status = await resolveSimulation({
    workspaceId: LOCAL_WORKSPACE_ID,
    userId: LOCAL_USER_ID,
    canonicalContent: content,
    contentSha256: contentHash(content),
    mapVersionId: "usmapv_pin",
  }, { waitMs: 5_000 });
  engine = SIM_CURRENT;
  assert.equal(status.state, "succeeded");
  if (status.state !== "succeeded") throw new Error("old engine simulation failed");
  await execute(
    `UPDATE simforge.drafts SET last_sim_key = :sim_key, last_sim_draft_version = :draft_version, last_sim_at = NOW()
      WHERE workspace_id = :workspace_id AND document_id = :document_id`,
    { sim_key: status.result.simKey, draft_version: draftVersion, workspace_id: LOCAL_WORKSPACE_ID, document_id: documentId },
  );
  return status.result.simKey;
}

before(async () => {
  await migrate();
  await seedPinnedMap();
  setSimulationExecutorForTests(async (subject) => simulation(String((subject.canonicalContent as { meta?: { name?: string } }).meta?.name ?? "s"), engine));
});

after(async () => {
  setSimulationExecutorForTests(null);
  await shutdownDatabase();
});

test("history rows are append-only; the expand window derives reason and origin from each other", async () => {
  const doc = await newDocument("Append only");
  const commit = await createScenarioRevision(context, doc.id, { expectedVersion: doc.draftVersion });
  assert.equal(commit.kind, "created");
  if (commit.kind !== "created") return;
  const row = await queryOne<{ sim_key: string; reason: string; origin: string; created_by_user_id: string | null }>(
    `SELECT sim_key, reason, origin, created_by_user_id FROM simforge.revision_simulations WHERE revision_id = :id`,
    { id: commit.revision.id },
  );
  assert.equal(row?.reason, "commit");
  assert.equal(row?.origin, "commit");
  assert.equal(row?.created_by_user_id, LOCAL_USER_ID);
  const pointer = await queryOne<{ sim_key: string }>(`SELECT sim_key FROM simforge.revision_active_simulation WHERE revision_id = :id`, { id: commit.revision.id });
  assert.equal(pointer?.sim_key, row?.sim_key);

  assert.match(await rejection(() => execute(
    `UPDATE simforge.revision_simulations SET reason = 'import' WHERE revision_id = :id`, { id: commit.revision.id },
  )), /simforge_revision_simulation_append_only/);
  assert.match(await rejection(() => execute(
    `DELETE FROM simforge.revision_simulations WHERE revision_id = :id`, { id: commit.revision.id },
  )), /simforge_revision_simulation_append_only/);
  // Account deletion (ON DELETE SET NULL) may clear the actor.
  await execute(`UPDATE simforge.revision_simulations SET created_by_user_id = NULL WHERE revision_id = :id`, { id: commit.revision.id });

  // An rc.73 writer names only `origin`, conflicting on (revision, engine_sem_ver).
  const other = await newDocument("Legacy writer");
  const legacy = await createScenarioRevision(context, other.id, { expectedVersion: other.draftVersion });
  assert.equal(legacy.kind, "created");
  if (legacy.kind !== "created") return;
  engine = SIM_OLD;
  const content = { ...LTAP, meta: { ...(LTAP.meta as object), name: "legacy-lazy" } };
  const lazy = await resolveSimulation({ workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID, canonicalContent: content, contentSha256: contentHash(content), mapVersionId: "usmapv_pin" }, { waitMs: 5_000 });
  engine = SIM_CURRENT;
  assert.equal(lazy.state, "succeeded");
  if (lazy.state !== "succeeded") return;
  await execute(
    `INSERT INTO simforge.revision_simulations (workspace_id, revision_id, engine_sem_ver, sim_key, origin)
     VALUES (:ws, :rev, :engine, :sim, 'lazy') ON CONFLICT (workspace_id, revision_id, engine_sem_ver) DO NOTHING`,
    { ws: LOCAL_WORKSPACE_ID, rev: legacy.revision.id, engine: lazy.result.engineSemVer, sim: lazy.result.simKey },
  );
  const derived = await queryOne<{ reason: string; motion_diff: unknown }>(
    `SELECT reason, motion_diff FROM simforge.revision_simulations WHERE revision_id = :rev AND sim_key = :sim`,
    { rev: legacy.revision.id, sim: lazy.result.simKey },
  );
  assert.equal(derived?.reason, "resimulate");
  assert.equal(derived?.motion_diff, null);

  // The one-time diff fill is allowed (needs a previous row); a second write is not.
  await assert.rejects(() => execute(
    `UPDATE simforge.revision_simulations SET motion_diff = '{"format":"x"}'::jsonb WHERE revision_id = :rev AND sim_key = :sim`,
    { rev: legacy.revision.id, sim: lazy.result.simKey },
  ), /simforge_revision_simulations_diff_check/, "a diff without a compared result is refused");

  // Deleting the document cascades through its revisions and their history.
  await execute(`DELETE FROM simforge.documents WHERE id = :id`, { id: other.id });
  const remaining = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM simforge.revision_simulations WHERE revision_id = :rev`, { rev: legacy.revision.id });
  assert.equal(Number(remaining?.n), 0);
});

test("an engine change under an unchanged draft raises the banner; keeping the old motion makes a version that replays it", async () => {
  const doc = await newDocument("Engine change");
  const oldSimKey = await oldEngineResultFor(doc.id, doc.draftVersion);

  const opened = await resolveDocumentSimulation(context, doc.id, { expectedVersion: doc.draftVersion, waitMs: 5_000 });
  assert.equal(opened.kind, "status");
  if (opened.kind !== "status" || opened.status.state !== "succeeded") assert.fail("the current engine's simulation should succeed");
  const currentSimKey = opened.status.result.simKey;
  assert.ok(opened.engineChange, "the banner is offered");
  assert.equal(opened.engineChange.previous.simKey, oldSimKey);
  assert.equal(opened.engineChange.previous.engineSemVer, "0.9.0");
  assert.equal(opened.engineChange.current.engineSemVer, "0.10.0");
  assert.equal(opened.engineChange.motionDiff.identical, false);
  assert.ok(opened.engineChange.motionDiff.maxPositionErrorM > 0.5, "12 m/s vs 10 m/s moves the car");
  assert.match(opened.engineChange.motionDiff.summary, /max .* m · 1 actor changed/);
  // Until the author decides, the draft still remembers the old result (and the banner comes back).
  const again = await resolveDocumentSimulation(context, doc.id, { expectedVersion: doc.draftVersion });
  assert.equal(again.kind === "status" && again.engineChange?.previous.simKey, oldSimKey);

  const kept = await keepPreviousMotion(context, doc.id, { expectedVersion: doc.draftVersion, previousSimKey: oldSimKey, currentSimKey });
  assert.equal(kept.kind, "created");
  if (kept.kind !== "created") return;

  const versions = await listDocumentVersions(context, doc.id);
  assert.ok(versions);
  const version = versions.versions.find((item) => item.revisionId === kept.revision.id);
  assert.ok(version);
  assert.equal(version.createdFor, "engine_upgrade");
  assert.equal(version.active?.simKey, oldSimKey, "the kept version replays the old engine's result");
  assert.deepEqual(version.simulations.map((sim) => [sim.engineSemVer, sim.reason, sim.active]).sort(), [
    ["0.10.0", "resimulate", false],
    ["0.9.0", "engine_upgrade", true],
  ]);
  const newer = version.simulations.find((sim) => sim.simKey === currentSimKey);
  assert.equal(newer?.previousSimKey, oldSimKey);
  assert.equal(newer?.motionDiff?.identical, false);
  assert.equal(newer?.motionDiff?.format, "simforge.simulation-diff/v1");

  // The draft moved on with the current engine: no banner any more.
  assert.equal(versions.draft.lastSimKey, currentSimKey);
  const settled = await resolveDocumentSimulation(context, doc.id, { expectedVersion: doc.draftVersion });
  assert.equal(settled.kind === "status" && settled.engineChange, null);

  // Rollback and roll forward move only the pointer.
  await selectVersionSimulation(context, doc.id, kept.revision.id, currentSimKey);
  let pointer = await queryOne<{ sim_key: string; reason: string }>(`SELECT sim_key, reason FROM simforge.revision_active_simulation WHERE revision_id = :id`, { id: kept.revision.id });
  assert.deepEqual(pointer, { sim_key: currentSimKey, reason: "user" });
  await selectVersionSimulation(context, doc.id, kept.revision.id, oldSimKey);
  pointer = await queryOne(`SELECT sim_key, reason FROM simforge.revision_active_simulation WHERE revision_id = :id`, { id: kept.revision.id });
  assert.equal(pointer?.sim_key, oldSimKey);
  // A result outside the history is refused.
  const foreign = await oldEngineResultFor((await newDocument("Foreign")).id, 1);
  await assert.rejects(() => selectVersionSimulation(context, doc.id, kept.revision.id, foreign), /not a simulation of revision/);

  // Re-simulating with the current engine finds the result already in the history.
  const resim = await resimulateVersion(context, doc.id, kept.revision.id, { waitMs: 5_000 });
  assert.equal(resim.status.state, "succeeded");
  assert.equal(resim.motionDiff?.identical, false);

  // Compare: both simulations side by side.
  const comparison = await compareSimulations(LOCAL_WORKSPACE_ID, oldSimKey, currentSimKey);
  assert.equal(comparison.base.engineSemVer, "0.9.0");
  assert.equal(comparison.candidate.engineSemVer, "0.10.0");
  assert.ok(comparison.playback.frames.length > 10);
  assert.ok(comparison.playback.frames.at(-1)!.actors.ego!.positionErrorM! > 0.5);

  // Restore: the version's frozen content.
  const content = await readVersionContent(context, doc.id, kept.revision.id);
  assert.equal(content.mapVersionId, "usmapv_pin");
  assert.equal((content.content as { meta: { name: string } }).meta.name, "Engine change");
});

test("identical motion across engines advances silently; accepting the new motion dismisses the banner", async () => {
  const same = await newDocument("Same motion");
  await oldEngineResultFor(same.id, same.draftVersion, { engineSemVer: "0.9.0", speed: 10 });
  const quiet = await resolveDocumentSimulation(context, same.id, { expectedVersion: same.draftVersion, waitMs: 5_000 });
  assert.equal(quiet.kind === "status" && quiet.engineChange, null, "identical motion needs no decision");
  const advanced = await queryOne<{ last_sim_key: string }>(`SELECT last_sim_key FROM simforge.drafts WHERE document_id = :id`, { id: same.id });
  assert.equal(quiet.kind === "status" && quiet.status.state === "succeeded" && quiet.status.result.simKey, advanced?.last_sim_key);

  const doc = await newDocument("Accept new motion");
  const oldSimKey = await oldEngineResultFor(doc.id, doc.draftVersion);
  const opened = await resolveDocumentSimulation(context, doc.id, { expectedVersion: doc.draftVersion, waitMs: 5_000 });
  assert.ok(opened.kind === "status" && opened.engineChange);
  const current = opened.engineChange.current.simKey;
  await acceptDraftSimulation(context, doc.id, { expectedVersion: doc.draftVersion, simKey: current });
  const after = await resolveDocumentSimulation(context, doc.id, { expectedVersion: doc.draftVersion });
  assert.equal(after.kind === "status" && after.engineChange, null);
  // The comparison is memoized (and symmetric keys are distinct entries).
  const memo = await queryRows(`SELECT 1 FROM simforge.sim_motion_diffs WHERE base_sim_key = :a AND candidate_sim_key = :b`, { a: oldSimKey, b: current });
  assert.equal(memo.length, 1);
  const identical = await simulationMotionDiff(LOCAL_WORKSPACE_ID, current, current).catch((error: Error) => error);
  assert.ok(identical instanceof Error, "a result is never compared with itself");
});

test("Save version names the version and records real provenance, not a constant compiler version", async () => {
  const doc = await newDocument("Saved");
  const saved = await saveDraftVersion(context, doc.id, { expectedVersion: doc.draftVersion, label: "Before tuning" });
  assert.equal(saved.kind, "created");
  if (saved.kind !== "created") return;
  const row = await queryOne<{ created_for: string; label: string; engine_sem_ver: string; oss_release: string; compiler_version: string }>(
    `SELECT created_for, label, engine_sem_ver, oss_release, compiler_version FROM simforge.revisions WHERE id = :id`,
    { id: saved.revision.id },
  );
  assert.equal(row?.created_for, "save");
  assert.equal(row?.label, "Before tuning");
  assert.equal(row?.engine_sem_ver, "0.10.0");
  assert.match(row?.oss_release ?? "", /^\d+\.\d+\.\d+/);
  assert.notEqual(row?.compiler_version, "uniscenario-compiler@2.0.0");
  assert.match(row?.compiler_version ?? "", /^@simforge-oss\/compiler@/);
  // The export is still dispatched under the compiler contract its worker claims.
  const exported = await queryOne<{ compiler_version: string }>(`SELECT compiler_version FROM simforge.exports WHERE revision_id = :id`, { id: saved.revision.id });
  assert.equal(exported?.compiler_version, "uniscenario-compiler@2.0.0");
});

test("gallery actors resolve by exact version whatever the asset's status; a missing one fails simulation loudly", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  await execute(
    `INSERT INTO asset_gallery.assets (id, catalog_slug, title, actor_class, created_by_user_id, created_by_workspace_id, visibility, status, current_version,
       removed_at, removed_by_user_id)
     VALUES (CAST(:id AS UUID), 'gallery.removed-cart', 'Removed cart', 'vehicle', :user, :ws, 'public', 'removed', 2, NOW(), :user)`,
    { id: assetId, user: LOCAL_USER_ID, ws: LOCAL_WORKSPACE_ID },
  );
  await execute(
    `INSERT INTO asset_gallery.asset_versions (asset_id, version, source_bucket, source_key, source_sha256, source_format, byte_length,
       dims, bounds, triangle_count, thumbnail_key, thumbnail_sha256, thumbnail_byte_length, verification_state)
     VALUES (CAST(:id AS UUID), 1, 'local-assets', 'gallery/cart.glb', :sha, 'glb', 10, '{"length":2,"width":1,"height":1}'::jsonb, '{}'::jsonb, 1,
       'gallery/cart.png', :sha, 10, 'verified')`,
    { id: assetId, sha: "9".repeat(64) },
  );
  const resolved = await resolveGalleryCatalogIds(["gallery.removed-cart.v1", "gallery.nowhere.v3"]);
  assert.deepEqual(resolved.entries.map((entry) => entry.catalogId), ["gallery.removed-cart.v1"]);
  assert.deepEqual(resolved.missing, ["gallery.nowhere.v3"]);
  await assert.rejects(() => requireGalleryCatalogEntries(["gallery.removed-cart.v1", "gallery.nowhere.v3"]), GalleryCatalogResolutionError);

  const content = { ...LTAP, meta: { ...(LTAP.meta as object), name: "missing-actor" }, extensions: { probe: { catalogId: "gallery.nowhere.v3" } } };
  const error = await resolveSimulation({
    workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID, canonicalContent: content, contentSha256: contentHash(content), mapVersionId: "usmapv_pin",
  }).catch((reason: unknown) => reason);
  assert.ok(error instanceof GalleryCatalogResolutionError);
  assert.equal(error.code, "actor_catalog_entry_missing");
  assert.deepEqual(error.missing, ["gallery.nowhere.v3"]);
});

test("a draft simulates on its pinned map version, superseded or retired; a changed pin fails loudly", async () => {
  const doc = await newDocument("Pinned draft");
  // A newer publication of the same map appears.
  await execute(
    `INSERT INTO simforge.map_versions (
       id, workspace_id, source_map_id, source_map_asset_id, label, browser_manifest_url, topology_artifact_url,
       xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256, descriptor, asset_catalog_version_id, created_at
     ) VALUES ('usmapv_pin2', :ws, 'map-pin', 'map-pin', 'Pin St', 'local://manifest', 'local://topology',
       'usart_pin_xodr', :xodr, 'epsg:32610', :coordinate, '{}'::jsonb, 'usacv_pin', NOW() + INTERVAL '1 hour')`,
    { ws: LOCAL_WORKSPACE_ID, xodr: "2".repeat(64), coordinate: "c".repeat(64) },
  );
  await execute(
    `INSERT INTO simforge.browser_asset_sets (id, workspace_id, map_version_id, closure_sha256, object_count, byte_length, asset_set_state)
     VALUES ('usbas_pin2', :ws, 'usmapv_pin2', :closure, 1, 1, 'available')`,
    { ws: LOCAL_WORKSPACE_ID, closure: "d".repeat(64) },
  );
  await setMembers("usbas_pin2", SIMULATION_MEMBERS);
  await execute(`UPDATE simforge.map_versions SET browser_asset_set_id = 'usbas_pin2' WHERE id = 'usmapv_pin2'`);

  const simulated = await resolveDocumentSimulation(context, doc.id, { expectedVersion: doc.draftVersion, waitMs: 5_000 });
  assert.equal(simulated.kind === "status" && simulated.status.state, "succeeded");
  if (simulated.kind !== "status" || simulated.status.state !== "succeeded") return;
  assert.equal(simulated.status.result.mapVersionId, "usmapv_pin", "the draft simulates on its pin, not the newest publication");

  const status = await draftMapPinStatus(context, doc.id);
  assert.equal(status?.pinned?.mapVersionId, "usmapv_pin");
  assert.equal(status?.pinned?.retired, false);
  assert.equal(status?.newer?.mapVersionId, "usmapv_pin2", "the newer publication is offered, not applied");
  assert.equal(status?.newerUnavailable, null);

  // Retiring the pinned version does not strand the draft.
  await execute(`UPDATE simforge.map_versions SET retired_at = NOW() WHERE id = 'usmapv_pin'`);
  const retired = await resolveDocumentSimulation(context, doc.id, { expectedVersion: doc.draftVersion, waitMs: 5_000 });
  assert.equal(retired.kind === "status" && retired.status.state, "succeeded");
  assert.equal((await draftMapPinStatus(context, doc.id))?.pinned?.retired, true);
  await execute(`UPDATE simforge.map_versions SET retired_at = NULL WHERE id = 'usmapv_pin'`);

  // A republication that changed a simulation member under the same version id is refused.
  await setMembers("usbas_pin", { ...SIMULATION_MEMBERS, "topology-index.json.gz": "f".repeat(64) });
  const mismatch = await resolveDocumentSimulation(context, doc.id, { expectedVersion: doc.draftVersion }).catch((error: unknown) => error);
  assert.ok(mismatch instanceof ScenarioMapResolutionError);
  assert.equal(mismatch.code, "scenario_map_pin_mismatch");
  await setMembers("usbas_pin", SIMULATION_MEMBERS);
});

test("purging a workspace cascades through its history rows", async () => {
  const ws = "ws_history_cascade";
  await execute(`INSERT INTO public.ba_organization (id, name, slug) VALUES ('org_history_cascade', 'c', 'c') ON CONFLICT (id) DO NOTHING`);
  await execute(
    `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
     VALUES (:ws, 'team', :ws, :ws, :user, 'org_history_cascade')`,
    { ws, user: LOCAL_USER_ID },
  );
  await execute(`INSERT INTO simforge.datasets (id, workspace_id, name) VALUES ('usds_cascade', :ws, 'c')`, { ws });
  const other = { ...context, workspaceId: ws } as AppContext;
  const created = await createScenarioDocument(other, {
    title: "Cascade",
    schemaVersion: "2",
    content: parseTemplate({ ...LTAP, meta: { ...(LTAP.meta as object), name: "Cascade" } }) as ScenarioTemplateV2,
    mapVersionId: "usmapv_pin",
    datasetId: "usds_cascade",
    authoringQualityId: "medium",
  });
  const revision = await createScenarioRevision(other, created.id, { expectedVersion: created.draftVersion });
  assert.equal(revision.kind, "created");
  const before = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM simforge.revision_simulations WHERE workspace_id = :ws`, { ws });
  assert.equal(Number(before?.n), 1);
  // Only the audited purge may hard-delete a workspace with results (20260923090000); its cascade
  // must pass the history's append-only trigger.
  await withTransaction(async (tx) => {
    await tx.execute(`SELECT set_config('simforge.workspace_purge', :ws, true)`, { ws });
    await tx.execute(`DELETE FROM public.workspaces WHERE id = :ws`, { ws });
  });
  const afterDelete = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM simforge.revision_simulations WHERE workspace_id = :ws`, { ws });
  assert.equal(Number(afterDelete?.n), 0);
});

test("a newer publication with different OpenDRIVE is offered only when its road geometry digest matches", async () => {
  const doc = await newDocument("Elevation refit");
  // An elevation-only refit: different OpenDRIVE bytes, the newest publication of the map.
  await execute(
    `INSERT INTO simforge.map_versions (
       id, workspace_id, source_map_id, source_map_asset_id, label, browser_manifest_url, topology_artifact_url,
       xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256, descriptor, asset_catalog_version_id, created_at
     ) VALUES ('usmapv_refit', :ws, 'map-pin', 'map-pin', 'Pin St refit', 'local://manifest', 'local://topology',
       'usart_pin_xodr', :xodr, 'epsg:32610', :coordinate, '{}'::jsonb, 'usacv_pin', NOW() + INTERVAL '2 hours')`,
    { ws: LOCAL_WORKSPACE_ID, xodr: "7".repeat(64), coordinate: "c".repeat(64) },
  );
  await execute(
    `INSERT INTO simforge.browser_asset_sets (id, workspace_id, map_version_id, closure_sha256, object_count, byte_length, asset_set_state)
     VALUES ('usbas_refit', :ws, 'usmapv_refit', :closure, 1, 1, 'available')`,
    { ws: LOCAL_WORKSPACE_ID, closure: "6".repeat(64) },
  );
  await setMembers("usbas_refit", { ...SIMULATION_MEMBERS, "map.xodr": "7".repeat(64) });
  await execute(`UPDATE simforge.map_versions SET browser_asset_set_id = 'usbas_refit' WHERE id = 'usmapv_refit'`);

  const drift = await draftMapPinStatus(context, doc.id);
  assert.equal(drift?.newer, null, "different road geometry is never offered as a move");
  assert.equal(drift?.newerUnavailable?.code, "scenario_map_geometry_drift");

  // Both publications carry the same geometry digest: the refit changed heights only.
  const geometry = "a".repeat(64);
  await execute(
    `UPDATE simforge.map_versions SET descriptor = descriptor || jsonb_build_object('xodrGeometrySha256', CAST(:geometry AS text))
      WHERE id IN ('usmapv_pin', 'usmapv_refit')`,
    { geometry },
  );
  const same = await draftMapPinStatus(context, doc.id);
  assert.equal(same?.newer?.mapVersionId, "usmapv_refit");
  assert.equal(same?.newerUnavailable, null);
  await execute(`UPDATE simforge.map_versions SET retired_at = NOW() WHERE id = 'usmapv_refit'`);
});
