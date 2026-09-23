import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ScenarioFormatError, parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import type { AppContext } from "@/app/lib/db/app-context";
import { execute, queryOne, shutdownDatabase } from "@/app/lib/db/data-api";
import { CreateScenarioDocumentSchema, UpdateScenarioDocumentSchema } from "../contracts";
import { canonicalContentSha256 } from "../core";
import { createScenarioDocument, getScenarioDocument } from "../document-store";
import { getScenarioRecordingRevisionInput } from "../recording-revision-store";
import { seedPinnedMap } from "./pinning-fixtures";

const HERE = dirname(fileURLToPath(import.meta.url));
const LTAP = JSON.parse(readFileSync(join(HERE, "../../../../../examples/ltap-opposing.template.json"), "utf8")) as Record<string, unknown>;
const MIGRATION = readFileSync(join(HERE, "../../../../migrations/20260923120100_scenario_schema_version_label.sql"), "utf8");
const context = { userId: LOCAL_USER_ID, workspaceId: LOCAL_WORKSPACE_ID, organizationId: LOCAL_ORGANIZATION_ID } as AppContext;

/** The migration's statements (between BEGIN and COMMIT), one per blank-line-separated block. */
function migrationStatements(): string[] {
  const body = MIGRATION.slice(MIGRATION.indexOf("BEGIN;") + "BEGIN;".length, MIGRATION.indexOf("COMMIT;"));
  return body.split(/\n\s*\n/).map((statement) => statement.trim().replace(/;$/, "")).filter(Boolean);
}

test("the route contract stores the canonical label and refuses unknown ones (a 400)", () => {
  const base = { title: "t", content: LTAP, datasetId: "usds_pin", authoringQualityId: "medium" };
  assert.equal(CreateScenarioDocumentSchema.parse(base).schemaVersion, "2");
  assert.equal(CreateScenarioDocumentSchema.parse({ ...base, schemaVersion: "2" }).schemaVersion, "2");
  assert.equal(CreateScenarioDocumentSchema.parse({ ...base, schemaVersion: "simforge.scenario.v2" }).schemaVersion, "2");
  for (const bad of ["bogus", "1", "3", "simforge.scenario.v3"]) {
    const parsed = CreateScenarioDocumentSchema.safeParse({ ...base, schemaVersion: bad });
    assert.equal(parsed.success, false, bad);
    assert.deepEqual(parsed.error?.issues.map((issue) => issue.path.join(".")), ["schemaVersion"]);
  }
  assert.equal(UpdateScenarioDocumentSchema.parse({ expectedVersion: 1 }).schemaVersion, undefined);
  assert.equal(UpdateScenarioDocumentSchema.parse({ expectedVersion: 1, schemaVersion: "simforge.scenario/v2" }).schemaVersion, "2");
  assert.equal(UpdateScenarioDocumentSchema.safeParse({ expectedVersion: 1, schemaVersion: "v2" }).success, false);
});

test("writers store \"2\", readers normalize, and the label migration relabels drafts and documents but never revisions", async (t) => {
  t.after(async () => {
    await shutdownDatabase();
  });
  await migrate();
  await seedPinnedMap();
  const content = parseTemplate(LTAP) as ScenarioTemplateV2;

  // Writer: the long spelling is stored as "2"; an unknown label is refused, not stored.
  const created = await createScenarioDocument(context, {
    title: "Label",
    schemaVersion: "simforge.scenario.v2",
    content,
    mapVersionId: "usmapv_pin",
    datasetId: "usds_pin",
    authoringQualityId: "medium",
  });
  assert.equal(created.schemaVersion, "2");
  const stored = await queryOne<{ draft: string; document: string }>(
    `SELECT dr.schema_version AS draft, d.schema_version AS document
       FROM simforge.documents d JOIN simforge.drafts dr ON dr.document_id = d.id WHERE d.id = :id`,
    { id: created.id },
  );
  assert.deepEqual(stored, { draft: "2", document: "2" });
  await assert.rejects(
    createScenarioDocument(context, { title: "Bad", schemaVersion: "bogus", content, mapVersionId: "usmapv_pin", datasetId: "usds_pin", authoringQualityId: "medium" }),
    (error: unknown) => error instanceof ScenarioFormatError && error.code === "schema_version_label_invalid",
  );

  // Rows written before the write-path normalizer: long labels on a draft, its document and a revision.
  const legacyId = "uscn_label_legacy";
  await execute(
    `INSERT INTO simforge.documents (id, workspace_id, title, schema_version, map_version_id, dataset_id, created_by_user_id, updated_by_user_id)
     VALUES (:id, :workspace_id, 'Legacy label', 'simforge.scenario.v2', 'usmapv_pin', 'usds_pin', :user_id, :user_id)`,
    { id: legacyId, workspace_id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID },
  );
  await execute(
    `INSERT INTO simforge.drafts (document_id, workspace_id, schema_version, canonical_content, content_sha256, map_version_id, updated_by_user_id)
     VALUES (:id, :workspace_id, 'simforge.scenario.v2', CAST(:content AS jsonb), :sha, 'usmapv_pin', :user_id)`,
    { id: legacyId, workspace_id: LOCAL_WORKSPACE_ID, content, sha: canonicalContentSha256(content), user_id: LOCAL_USER_ID },
  );
  await execute(
    `INSERT INTO simforge.revisions (id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
       canonical_content, content_sha256, map_version_id, compiler_version)
     VALUES ('usrev_label_legacy', :workspace_id, :id, 1, 1, 'simforge.scenario.v2', CAST(:content AS jsonb), :sha, 'usmapv_pin', 'test')`,
    { id: legacyId, workspace_id: LOCAL_WORKSPACE_ID, content, sha: canonicalContentSha256(content) },
  );

  // Reader: normalized label, content through the upgrader chain.
  const legacy = await getScenarioDocument(context, legacyId);
  assert.equal(legacy?.schemaVersion, "2");
  assert.deepEqual(legacy?.content, content);
  const revision = await getScenarioRecordingRevisionInput(context, "usrev_label_legacy");
  assert.deepEqual(revision?.content, content);

  // The migration relabels the draft and the document; the revision keeps its label.
  const statements = migrationStatements();
  assert.equal(statements.length, 3);
  for (const statement of statements) await execute(statement);
  const after = await queryOne<{ draft: string; document: string; revision: string; draft_version: number; sha: string }>(
    `SELECT dr.schema_version AS draft, d.schema_version AS document, r.schema_version AS revision,
            dr.draft_version, dr.content_sha256 AS sha
       FROM simforge.documents d
       JOIN simforge.drafts dr ON dr.document_id = d.id
       JOIN simforge.revisions r ON r.document_id = d.id
      WHERE d.id = :id`,
    { id: legacyId },
  );
  assert.deepEqual(after, { draft: "2", document: "2", revision: "simforge.scenario.v2", draft_version: 1, sha: canonicalContentSha256(content) });

  // A draft label no reader understands: the reader refuses it, and the migration's check fails loudly.
  await execute(`UPDATE simforge.drafts SET schema_version = 'garbage' WHERE document_id = :id`, { id: legacyId });
  await assert.rejects(
    getScenarioDocument(context, legacyId),
    (error: unknown) => error instanceof ScenarioFormatError && error.code === "schema_version_label_invalid",
  );
  await assert.rejects(execute(statements[2]!), /draft\(s\) still carry a label other than '2'/);
  await execute(`UPDATE simforge.drafts SET schema_version = '2' WHERE document_id = :id`, { id: legacyId });
});
