import "../../models/__tests__/test-env";
// The authoritative simulation stores its trace as a local object, signed with the supervised host's token.
process.env.SIMFORGE_LOCAL_HOST_TOKEN ??= "document-pinning-test-token";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AMBIENT_TRAFFIC_EXTENSION_KEY, ambientTrafficProfileForDocument } from "@simforge-oss/engine";
import { legacyTemplateSeed, parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { ScenarioMapResolutionError } from "@simforge-oss/studio-host";

import { migrate } from "../../../../scripts/migrate";
import { pinScenarioDocuments } from "../../../../scripts/pin-scenario-documents";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import type { AppContext } from "@/app/lib/db/app-context";
import { execute, queryOne, shutdownDatabase } from "@/app/lib/db/data-api";
import { EMPTY_AMBIENT_CONFIG_SHA256, EMPTY_AMBIENT_RESULT_SHA256, UpdateScenarioDocumentSchema } from "../contracts";
import { renderSeed } from "../render-intent-store";
import { canonicalContentSha256 } from "../core";
import { LEGACY_AMBIENT_PROFILE, pinStoredDocument } from "../document-pinning";
import { CLOSURE_A, CLOSURE_B, seedPinnedMap, setMembers, SIMULATION_MEMBERS, simulationClosureSha256 } from "./pinning-fixtures";
import { setSimulationExecutorForTests } from "../sim-result-store";
import { fakeAuthoritativeSimulation } from "./sim-fixtures";

const SIM_A = simulationClosureSha256(SIMULATION_MEMBERS);
const SIM_B = simulationClosureSha256({ ...SIMULATION_MEMBERS, "topology-index.json.gz": "e".repeat(64) });
import {
  createScenarioDocument,
  createScenarioRevision,
  getScenarioDocument,
  updateScenarioDocument,
} from "../document-store";

const HERE = dirname(fileURLToPath(import.meta.url));
const LTAP = JSON.parse(readFileSync(join(HERE, "../../../../../examples/ltap-opposing.template.json"), "utf8")) as Record<string, unknown>;
const context = { userId: LOCAL_USER_ID, workspaceId: LOCAL_WORKSPACE_ID, organizationId: LOCAL_ORGANIZATION_ID } as AppContext;
const disabledAmbient = {
  mode: "disabled" as const,
  ambientConfig: {},
  configSha256: EMPTY_AMBIENT_CONFIG_SHA256,
  resultSha256: EMPTY_AMBIENT_RESULT_SHA256,
};

function legacyContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { simulation: _drop, ...rest } = LTAP as Record<string, unknown> & { simulation?: unknown };
  return { ...rest, ...overrides };
}

test("the one-time pin writes the seed a document resolves to today and its legacy ambient default", () => {
  const raw = legacyContent();
  const legacy = parseTemplate(raw);
  const outcome = pinStoredDocument(raw);
  assert.equal(outcome.kind, "pinned");
  if (outcome.kind !== "pinned") return;
  assert.equal(outcome.seed, legacyTemplateSeed(legacy));
  assert.deepEqual(outcome.content.simulation, { seed: legacyTemplateSeed(legacy), dtS: 0.02 });
  assert.equal(outcome.addedAmbientProfile, true);
  assert.deepEqual(outcome.content.extensions?.[AMBIENT_TRAFFIC_EXTENSION_KEY], LEGACY_AMBIENT_PROFILE);
  // The pinned document resolves to exactly the profile the unpinned one did.
  assert.deepEqual(ambientTrafficProfileForDocument(outcome.content), ambientTrafficProfileForDocument(legacy));
  // Idempotent.
  assert.equal(pinStoredDocument(outcome.content).kind, "unchanged");
});

test("the pin keeps an explicit profile, and refuses to repair a malformed one", () => {
  const off = { version: 1, preset: "off" };
  const kept = pinStoredDocument(legacyContent({ extensions: { [AMBIENT_TRAFFIC_EXTENSION_KEY]: off } }));
  assert.equal(kept.kind, "pinned");
  if (kept.kind === "pinned") {
    assert.equal(kept.addedAmbientProfile, false);
    assert.deepEqual(kept.content.extensions?.[AMBIENT_TRAFFIC_EXTENSION_KEY], off);
  }
  const broken = pinStoredDocument(legacyContent({ extensions: { [AMBIENT_TRAFFIC_EXTENSION_KEY]: { preset: "gridlock" } } }));
  assert.equal(broken.kind, "invalid_ambient_profile");
});

test("a malformed ambient profile is refused at the write boundary", () => {
  const good = UpdateScenarioDocumentSchema.safeParse({ expectedVersion: 1, content: legacyContent() });
  assert.equal(good.success, true);
  const bad = UpdateScenarioDocumentSchema.safeParse({
    expectedVersion: 1,
    content: legacyContent({ extensions: { [AMBIENT_TRAFFIC_EXTENSION_KEY]: { preset: "gridlock" } } }),
  });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error?.issues), /Invalid ambient traffic profile/);
});

test("the render seed follows the pinned seed, not the content digest", () => {
  const pinned = { simulation: { seed: "fixed", dtS: 0.02 } };
  assert.equal(renderSeed(pinned, "1".repeat(64)), renderSeed(pinned, "2".repeat(64)));
  assert.notEqual(renderSeed({ simulation: { seed: "other", dtS: 0.02 } }, "1".repeat(64)), renderSeed(pinned, "1".repeat(64)));
  // A revision frozen before pinning keeps its legacy seed: the first 32 bits of its digest.
  assert.equal(renderSeed({}, "0000abcd" + "0".repeat(56)), 0xabcd);
});

test("drafts are stored pinned, revisions freeze the pin, and nothing re-resolves", async (t) => {
  t.after(async () => {
    setSimulationExecutorForTests(null);
    await shutdownDatabase();
  });
  await migrate();
  await seedPinnedMap();
  // Committing resolves the draft's authoritative simulation first; the
  // fixture map has no real closure, so a tiny real simulation stands in.
  setSimulationExecutorForTests(async () => fakeAuthoritativeSimulation("pinning", { assetId: "map-pin", versionId: "usmapv_pin" }));

  // Create: content without a block is stored with its one-time pin, plus the map pin.
  const created = await createScenarioDocument(context, {
    title: "Pinned",
    schemaVersion: "simforge.scenario/v2",
    content: parseTemplate(legacyContent()) as ScenarioTemplateV2,
    mapVersionId: "usmapv_pin",
    datasetId: "usds_pin",
    authoringQualityId: "medium",
  });
  const seedValue = legacyTemplateSeed(parseTemplate(legacyContent()));
  assert.deepEqual(created.content.simulation, { seed: seedValue, dtS: 0.02 });
  assert.equal(created.mapClosureSha256, SIM_A);
  assert.equal(created.assetCatalogVersionId, "usacv_pin");

  // Rename + save content WITHOUT the block: the stored block survives, so the seed does not move.
  const { simulation: _omit, ...withoutBlock } = created.content;
  const renamed = await updateScenarioDocument(context, created.id, {
    expectedVersion: created.draftVersion,
    title: "Renamed",
    content: { ...withoutBlock, meta: { ...withoutBlock.meta, name: "A different name" } } as ScenarioTemplateV2,
  });
  assert.equal(renamed.kind, "updated");
  if (renamed.kind !== "updated") return;
  assert.deepEqual(renamed.document.content.simulation, { seed: seedValue, dtS: 0.02 });

  // Commit: the revision freezes the pinned version, closure and catalog.
  const committed = await createScenarioRevision(context, created.id, { expectedVersion: renamed.document.draftVersion, ambient: disabledAmbient });
  assert.equal(committed.kind, "created");
  const revision = await queryOne<{ revision_number: number; map_version_id: string; map_closure_sha256: string; asset_catalog_version_id: string }>(
    `SELECT revision_number, map_version_id, map_closure_sha256, asset_catalog_version_id FROM simforge.revisions WHERE document_id = :id`,
    { id: created.id },
  );
  assert.deepEqual({ ...revision, revision_number: Number(revision?.revision_number) }, {
    revision_number: 1, map_version_id: "usmapv_pin", map_closure_sha256: SIM_A, asset_catalog_version_id: "usacv_pin",
  });

  // Two commits of the same draft version serialize on the draft lock: one revision, not a unique-key failure.
  const again = await Promise.all([
    createScenarioRevision(context, created.id, { expectedVersion: renamed.document.draftVersion, ambient: disabledAmbient }),
    createScenarioRevision(context, created.id, { expectedVersion: renamed.document.draftVersion, ambient: disabledAmbient }),
  ]);
  assert.deepEqual(again.map((result) => result.kind), ["created", "created"]);
  const count = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM simforge.revisions WHERE document_id = :id`, { id: created.id });
  assert.equal(Number(count?.n), 1);

  // The version's closure changes underneath the pin: an explicit error, never a silent substitution.
  const edited = await updateScenarioDocument(context, created.id, {
    expectedVersion: renamed.document.draftVersion,
    content: { ...renamed.document.content, meta: { ...renamed.document.content.meta, description: "edited" } },
  });
  assert.equal(edited.kind, "updated");
  if (edited.kind !== "updated") return;
  // A republication that only adds derived members (a SUMO network, an ambient
  // turn-verdict table) keeps the simulation members: the pin still holds.
  await execute(
    `INSERT INTO simforge.browser_asset_sets (id, workspace_id, map_version_id, closure_sha256, object_count, byte_length, asset_set_state)
     VALUES ('usbas_pin_derived', :workspace_id, 'usmapv_pin', :closure, 1, 1, 'available')`,
    { workspace_id: LOCAL_WORKSPACE_ID, closure: CLOSURE_B },
  );
  await setMembers("usbas_pin_derived", { ...SIMULATION_MEMBERS, "derived/ambient/turn-verdicts.json.gz": "9".repeat(64) });
  await execute(`UPDATE simforge.browser_asset_sets SET asset_set_state = 'retired' WHERE id = 'usbas_pin'`);
  await execute(`UPDATE simforge.map_versions SET browser_asset_set_id = 'usbas_pin_derived' WHERE id = 'usmapv_pin'`);
  const derivedOnly = await createScenarioRevision(context, created.id, { expectedVersion: edited.document.draftVersion, ambient: disabledAmbient });
  assert.equal(derivedOnly.kind, "created");
  // A pin written as the browser-closure digest (before pins covered only the
  // simulation members) is honoured while those members are unchanged.
  await execute(`UPDATE simforge.drafts SET map_closure_sha256 = :closure WHERE document_id = :id`, { closure: CLOSURE_A, id: created.id });
  const legacyEdit = await updateScenarioDocument(context, created.id, {
    expectedVersion: edited.document.draftVersion,
    content: { ...edited.document.content, meta: { ...edited.document.content.meta, description: "legacy pin" } },
  });
  assert.equal(legacyEdit.kind, "updated");
  if (legacyEdit.kind !== "updated") return;
  assert.equal(legacyEdit.document.mapClosureSha256, CLOSURE_A);
  const legacyPinned = await createScenarioRevision(context, created.id, { expectedVersion: legacyEdit.document.draftVersion, ambient: disabledAmbient });
  assert.equal(legacyPinned.kind, "created");
  const legacyRevision = await queryOne<{ map_closure_sha256: string }>(
    `SELECT map_closure_sha256 FROM simforge.revisions WHERE document_id = :id ORDER BY revision_number DESC LIMIT 1`,
    { id: created.id },
  );
  assert.equal(legacyRevision?.map_closure_sha256, SIM_A);

  // A simulation member changes underneath the pin: an explicit error, never a silent substitution.
  await setMembers("usbas_pin_derived", { "topology-index.json.gz": "e".repeat(64) });
  const afterChange = await updateScenarioDocument(context, created.id, {
    expectedVersion: legacyEdit.document.draftVersion,
    content: { ...legacyEdit.document.content, meta: { ...legacyEdit.document.content.meta, description: "after change" } },
  });
  assert.equal(afterChange.kind, "updated");
  if (afterChange.kind !== "updated") return;
  await assert.rejects(
    createScenarioRevision(context, created.id, { expectedVersion: afterChange.document.draftVersion, ambient: disabledAmbient }),
    (error: unknown) => error instanceof ScenarioMapResolutionError && error.code === "scenario_map_pin_mismatch",
  );

  // An ordinary save keeps the stale pin; only an explicit re-pin adopts the version's current closure.
  const saved = await updateScenarioDocument(context, created.id, { expectedVersion: afterChange.document.draftVersion, title: "Saved" });
  assert.equal(saved.kind, "updated");
  if (saved.kind !== "updated") return;
  assert.equal(saved.document.mapClosureSha256, CLOSURE_A);  // the legacy pin set above
  const repinned = await updateScenarioDocument(context, created.id, { expectedVersion: saved.document.draftVersion, mapVersionId: "usmapv_pin" });
  assert.equal(repinned.kind, "updated");
  if (repinned.kind !== "updated") return;
  assert.equal(repinned.document.mapClosureSha256, SIM_B);
  assert.equal(repinned.document.draftVersion, saved.document.draftVersion + 1);
  const recommitted = await createScenarioRevision(context, created.id, { expectedVersion: repinned.document.draftVersion, ambient: disabledAmbient });
  assert.equal(recommitted.kind, "created");

  // A pinned version that is retired is refused explicitly.
  await execute(`UPDATE simforge.map_versions SET retired_at = NOW() WHERE id = 'usmapv_pin'`);
  const touched = await updateScenarioDocument(context, created.id, {
    expectedVersion: repinned.document.draftVersion,
    content: { ...repinned.document.content, meta: { ...repinned.document.content.meta, description: "after retirement" } },
  });
  assert.equal(touched.kind, "updated");
  if (touched.kind !== "updated") return;
  await assert.rejects(
    createScenarioRevision(context, created.id, { expectedVersion: touched.document.draftVersion, ambient: disabledAmbient }),
    (error: unknown) => error instanceof ScenarioMapResolutionError && error.code === "scenario_map_version_unavailable",
  );
  await execute(`UPDATE simforge.map_versions SET retired_at = NULL WHERE id = 'usmapv_pin'`);

  // The one-time script pins a legacy draft in place and bumps its version.
  const legacyId = "uscn_legacy_pin";
  await execute(
    `INSERT INTO simforge.documents (id, workspace_id, title, schema_version, map_version_id, dataset_id, created_by_user_id, updated_by_user_id)
     VALUES (:id, :workspace_id, 'Legacy', 'simforge.scenario/v2', 'usmapv_pin', 'usds_pin', :user_id, :user_id)`,
    { id: legacyId, workspace_id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID },
  );
  const legacy = parseTemplate(legacyContent());
  await execute(
    `INSERT INTO simforge.drafts (document_id, workspace_id, schema_version, canonical_content, content_sha256, map_version_id, updated_by_user_id)
     VALUES (:id, :workspace_id, 'simforge.scenario/v2', CAST(:content AS jsonb), :sha, 'usmapv_pin', :user_id)`,
    { id: legacyId, workspace_id: LOCAL_WORKSPACE_ID, content: legacy, sha: canonicalContentSha256(legacy), user_id: LOCAL_USER_ID },
  );
  const dry = await pinScenarioDocuments({ apply: false });
  assert.equal(dry.pinned, 1);
  const applied = await pinScenarioDocuments({ apply: true });
  assert.equal(applied.pinned, 1);
  assert.deepEqual(applied.raced, []);
  const pinnedLegacy = await getScenarioDocument(context, legacyId);
  assert.equal(pinnedLegacy?.draftVersion, 2);
  assert.deepEqual(pinnedLegacy?.content.simulation, { seed: legacyTemplateSeed(legacy), dtS: 0.02 });
  assert.equal(pinnedLegacy?.contentSha256, canonicalContentSha256(pinnedLegacy!.content));
  const rerun = await pinScenarioDocuments({ apply: true });
  assert.equal(rerun.pinned, 0);

  // Migration 20260922180000 rewrites a browser-closure pin of the version's
  // current publication to its simulation-member digest, and nothing else.
  const current = await queryOne<{ closure_sha256: string }>(
    `SELECT bs.closure_sha256 FROM simforge.map_versions mv JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id WHERE mv.id = 'usmapv_pin'`,
  );
  await execute(`UPDATE simforge.drafts SET map_closure_sha256 = :closure WHERE document_id = :id`, { closure: current!.closure_sha256, id: legacyId });
  await execute(`UPDATE simforge.drafts SET map_closure_sha256 = :closure WHERE document_id = :id`, { closure: "f".repeat(64), id: created.id });
  const migration = readFileSync(new URL("../../../../migrations/20260922180000_scenario_pin_simulation_closure.sql", import.meta.url), "utf8");
  await execute(migration.slice(migration.indexOf("UPDATE simforge.drafts"), migration.indexOf("COMMIT;")).trim().replace(/;$/, ""));
  const rewritten = await queryOne<{ map_closure_sha256: string }>(`SELECT map_closure_sha256 FROM simforge.drafts WHERE document_id = :id`, { id: legacyId });
  assert.equal(rewritten?.map_closure_sha256, SIM_B);
  const untouched = await queryOne<{ map_closure_sha256: string }>(`SELECT map_closure_sha256 FROM simforge.drafts WHERE document_id = :id`, { id: created.id });
  assert.equal(untouched?.map_closure_sha256, "f".repeat(64));
});
