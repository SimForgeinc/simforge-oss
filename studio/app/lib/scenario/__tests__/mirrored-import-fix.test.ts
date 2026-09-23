import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { test } from "node:test";

import { detectMirroredOpenScenarioImport, parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { fixMirroredOpenScenarioImports } from "../../../../scripts/fix-mirrored-openscenario-imports";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import type { AppContext } from "@/app/lib/db/app-context";
import { execute, queryOne, shutdownDatabase } from "@/app/lib/db/data-api";
import { canonicalContentSha256 } from "../core";
import { createScenarioDocument, getScenarioDocument, updateScenarioDocument } from "../document-store";
import { seedPinnedMap } from "./pinning-fixtures";

const context = { userId: LOCAL_USER_ID, workspaceId: LOCAL_WORKSPACE_ID, organizationId: LOCAL_ORGANIZATION_ID } as AppContext;
const IMPORTED_AT = "2026-09-20T10:00:00.000Z";

/** A draft as the pre-b79130bb importer wrote it: scene z = +y_osc. */
function mirroredImport(name: string): ScenarioTemplateV2 {
  return parseTemplate({
    scenarioVersion: 2,
    meta: { name, createdAt: IMPORTED_AT, modifiedAt: IMPORTED_AT, appVersion: "xosc-import/v1", tags: ["openscenario-import"], author: "OpenSCENARIO import" },
    sourceMap: { mapId: "map-pin", mapName: "Pinned map" },
    anchor: { id: "imported_scene", pin: { mapId: "map-pin" } },
    roles: [
      { id: "Ego", kind: "scene_absolute", label: "Ego", actor: { class: "car", static: false }, pose: { position: { x: 12, y: 0, z: 7.5 }, headingRad: 0.5 }, initialSpeedKph: 36 },
      { id: "Parked", kind: "scene_absolute", label: "Parked", actor: { class: "static_object", static: true }, pose: { position: { x: 20, y: 0, z: -3 }, headingRad: 0 } },
    ],
    choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [] },
    metricSubject: "Ego",
    extensions: {
      openScenarioImport: {
        version: 1,
        importedAt: IMPORTED_AT,
        source: { byteLength: 10, sha256: "a".repeat(64), fileName: `${name}.xosc`, mediaType: "application/xml", artifactId: "art_1" },
        mapResolution: { mapVersionId: "usmapv_pin", label: "Pinned map" },
        report: {
          standard: "ASAM OpenSCENARIO XML 1.2",
          logicFile: null,
          embeddedMapIdentity: { mapVersionId: "usmapv_pin", mapId: null, xodrSha256: null },
          diagnostics: [{ code: "world_positions_preserved", path: "Storyboard.Init", disposition: "supported", message: "2 actor world positions preserved exactly in a map-pinned v2 draft." }],
          capabilities: { supported: 1, approximated: 0, unsupported: 0 },
        },
      },
    },
  });
}

async function create(content: ScenarioTemplateV2, title: string) {
  return createScenarioDocument(context, {
    title,
    schemaVersion: "simforge.scenario/v2",
    content,
    mapVersionId: "usmapv_pin",
    datasetId: "usds_pin",
    authoringQualityId: "medium",
  });
}

function pose(document: { content: ScenarioTemplateV2 }, id: string) {
  const role = document.content.roles.find((entry) => entry.id === id);
  assert.ok(role && role.kind === "scene_absolute");
  return role.pose;
}

test("the one-time script plans by default, repairs drafts with --apply under a version guard, and is idempotent", async (t) => {
  t.after(shutdownDatabase);
  await migrate();
  await seedPinnedMap();

  const imported = await create(mirroredImport("imported"), "Imported");
  const edited = await create(mirroredImport("edited"), "Edited");
  const { extensions: _drop, ...plainTemplate } = mirroredImport("plain");
  const plain = await create(parseTemplate(plainTemplate), "Plain");
  const deleted = await create(mirroredImport("deleted"), "Deleted");
  await execute(`UPDATE simforge.documents SET deleted_at = NOW() WHERE id = :id`, { id: deleted.id });

  // The author lane-snapped one imported actor before the fix existed.
  const snapped = structuredClone(edited.content) as ScenarioTemplateV2;
  const parked = snapped.roles.find((role) => role.id === "Parked")!;
  if (parked.kind === "scene_absolute") parked.laneRef = { roadId: "1", section: 0, laneId: -1, s: 3, t: 0, headingOffsetRad: 0 };
  const editedSaved = await updateScenarioDocument(context, edited.id, { expectedVersion: edited.draftVersion, content: snapped });
  assert.equal(editedSaved.kind, "updated");

  const lines: string[] = [];
  const dry = await fixMirroredOpenScenarioImports({ apply: false, log: (line) => lines.push(line) });
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.scanned, 2, "live imported drafts only: not the plain or the deleted one");
  assert.equal(dry.affected, 2);
  assert.equal(dry.written, 0);
  const plan = dry.documents.find((entry) => entry.documentId === imported.id)!;
  assert.deepEqual(plan.roles, [{ id: "Ego", zBefore: 7.5, zAfter: -7.5 }, { id: "Parked", zBefore: -3, zAfter: 3 }]);
  assert.equal(plan.workspaceId, LOCAL_WORKSPACE_ID);
  assert.ok(lines.some((line) => line.startsWith(imported.id) && line.includes("status=affected")));
  assert.ok(lines.includes("    flip Ego: z 7.5 -> -7.5"));
  assert.ok(lines.includes("    keep Parked: lane_anchored"));
  // A dry run writes nothing.
  assert.equal((await getScenarioDocument(context, imported.id))?.draftVersion, imported.draftVersion);

  const now = new Date("2026-09-23T00:00:00.000Z");
  const applied = await fixMirroredOpenScenarioImports({ apply: true, now });
  assert.equal(applied.written, 2);
  assert.deepEqual(applied.raced, []);

  const repaired = (await getScenarioDocument(context, imported.id))!;
  assert.equal(repaired.draftVersion, imported.draftVersion + 1);
  assert.deepEqual(pose(repaired, "Ego"), { position: { x: 12, y: 0, z: -7.5 }, headingRad: 0.5 });
  assert.deepEqual(pose(repaired, "Parked"), { position: { x: 20, y: 0, z: 3 }, headingRad: 0 });
  assert.equal(repaired.contentSha256, canonicalContentSha256(repaired.content));
  assert.deepEqual((repaired.content.extensions?.openScenarioImport as { mirrorFix: unknown }).mirrorFix, {
    version: 1, appliedAt: now.toISOString(), roles: ["Ego", "Parked"], skipped: [],
  });
  const editedRepaired = (await getScenarioDocument(context, edited.id))!;
  assert.equal(pose(editedRepaired, "Ego").position.z, -7.5);
  assert.equal(pose(editedRepaired, "Parked").position.z, -3, "the lane-snapped actor stays where the author put it");

  // The plain and the deleted document are untouched.
  assert.equal((await getScenarioDocument(context, plain.id))?.draftVersion, plain.draftVersion);
  const deletedRow = await queryOne<{ draft_version: number }>(`SELECT draft_version FROM simforge.drafts WHERE document_id = :id`, { id: deleted.id });
  assert.equal(Number(deletedRow?.draft_version), deleted.draftVersion);

  // An editor still holding the old version conflicts instead of writing the mirrored poses back.
  const stale = await updateScenarioDocument(context, imported.id, { expectedVersion: imported.draftVersion, content: imported.content });
  assert.equal(stale.kind, "conflict");
  // The editor's normal save path (PATCH with expectedVersion) accepts the repaired document.
  const saved = await updateScenarioDocument(context, imported.id, { expectedVersion: repaired.draftVersion, content: repaired.content, title: "Imported (fixed)" });
  assert.equal(saved.kind, "updated");
  assert.equal(detectMirroredOpenScenarioImport(saved.kind === "updated" ? saved.document.content : null).status, "already_fixed");

  const rerun = await fixMirroredOpenScenarioImports({ apply: true });
  assert.equal(rerun.alreadyFixed, 2);
  assert.equal(rerun.written, 0);

  const scoped = await fixMirroredOpenScenarioImports({ apply: false, documentIds: [edited.id] });
  assert.deepEqual(scoped.documents.map((entry) => entry.documentId), [edited.id]);
});
