// PGlite by default; SIMFORGE_TEST_DATABASE_URL runs the same assertions on a real server.
import "../../scenario/__tests__/pg/pg-env";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../auth/session";
import { seedPinnedMap } from "../../scenario/__tests__/pinning-fixtures";
import { execute, queryOne, shutdownDatabase, withTransaction } from "../data-api";

/**
 * 20260923090000 (workspace purge guard) and 20260923090100 (revision
 * immutability), against the real migration chain on PGlite.
 */
const SHA = (c: string) => c.repeat(64);

async function seedWorkspace(id: string): Promise<void> {
  await execute(
    `INSERT INTO public.ba_organization (id, name, slug) VALUES (:id, :id, :id) ON CONFLICT (id) DO NOTHING`,
    { id: `org_${id}` },
  );
  await execute(
    `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
     VALUES (:id, 'team', :id, :id, :user_id, :organization_id) ON CONFLICT (id) DO NOTHING`,
    { id, user_id: LOCAL_USER_ID, organization_id: `org_${id}` },
  );
}

async function seedRevision(input: { workspaceId: string; documentId: string; revisionId: string; createdBy?: string }): Promise<void> {
  await execute(
    `INSERT INTO simforge.datasets (id, workspace_id, name) VALUES (:id, :workspace_id, :id) ON CONFLICT (id) DO NOTHING`,
    { id: `usds_${input.workspaceId}`, workspace_id: input.workspaceId },
  );
  await execute(
    `INSERT INTO simforge.documents (id, workspace_id, title, schema_version, dataset_id)
     VALUES (:id, :workspace_id, 'guarded', '2', :dataset_id) ON CONFLICT (id) DO NOTHING`,
    { id: input.documentId, workspace_id: input.workspaceId, dataset_id: `usds_${input.workspaceId}` },
  );
  await execute(
    `INSERT INTO simforge.revisions (
       id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
       canonical_content, content_sha256, compiler_version, map_version_id, created_by_user_id, ambient_result_sha256
     ) VALUES (:id, :workspace_id, :document_id, 1, 1, '2', CAST(:content AS jsonb), :sha, 'test', 'usmapv_pin', :created_by, :traffic)`,
    {
      id: input.revisionId, workspace_id: input.workspaceId, document_id: input.documentId,
      content: JSON.stringify({ scenarioVersion: 2 }), sha: SHA("a"), created_by: input.createdBy ?? LOCAL_USER_ID, traffic: SHA("c"),
    },
  );
}

async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the statement to be rejected");
}

before(async () => {
  await migrate();
  await seedPinnedMap();
});
after(() => shutdownDatabase());

test("a workspace owning revisions cannot be hard-deleted outside the audited purge", async () => {
  await seedWorkspace("ws_empty");
  await execute(`DELETE FROM public.workspaces WHERE id = 'ws_empty'`);
  assert.equal(await queryOne(`SELECT id FROM public.workspaces WHERE id = 'ws_empty'`), null);

  await seedWorkspace("ws_owned");
  await seedRevision({ workspaceId: "ws_owned", documentId: "usdoc_owned", revisionId: "usrev_owned" });
  const message = await rejection(() => execute(`DELETE FROM public.workspaces WHERE id = 'ws_owned'`));
  assert.match(message, /workspace_has_immutable_results/);

  // A purge authorization for a different workspace does not carry over.
  const wrongTarget = await rejection(() => withTransaction(async (tx) => {
    await tx.queryRows(`SELECT set_config('simforge.workspace_purge', 'ws_other', true)`);
    await tx.execute(`DELETE FROM public.workspaces WHERE id = 'ws_owned'`);
  }));
  assert.match(wrongTarget, /workspace_has_immutable_results/);
  assert.ok(await queryOne(`SELECT id FROM simforge.revisions WHERE id = 'usrev_owned'`));

  // The purge path names the workspace for its own transaction only.
  await withTransaction(async (tx) => {
    await tx.queryRows(`SELECT set_config('simforge.workspace_purge', 'ws_owned', true)`);
    await tx.execute(`DELETE FROM public.workspaces WHERE id = 'ws_owned'`);
  });
  assert.equal(await queryOne(`SELECT id FROM simforge.revisions WHERE id = 'usrev_owned'`), null);
  const leaked = await queryOne<{ value: string | null }>(`SELECT current_setting('simforge.workspace_purge', true) AS value`);
  assert.ok(!leaked?.value, "the purge authorization must not outlive its transaction");
});

test("revisions reject content changes and allow only the three non-semantic writes", async () => {
  await seedRevision({ workspaceId: LOCAL_WORKSPACE_ID, documentId: "usdoc_immutable", revisionId: "usrev_immutable" });

  for (const statement of [
    `UPDATE simforge.revisions SET canonical_content = CAST('{"scenarioVersion":2,"x":1}' AS jsonb) WHERE id = 'usrev_immutable'`,
    `UPDATE simforge.revisions SET content_sha256 = '${SHA("b")}' WHERE id = 'usrev_immutable'`,
    `UPDATE simforge.revisions SET map_version_id = NULL WHERE id = 'usrev_immutable'`,
    `UPDATE simforge.revisions SET ambient_mode = 'native' WHERE id = 'usrev_immutable'`,
    `UPDATE simforge.revisions SET created_by_user_id = NULL, compiler_version = 'other' WHERE id = 'usrev_immutable'`,
  ]) {
    assert.match(await rejection(() => execute(statement)), /simforge_revision_immutable/, statement);
  }

  // 1. No-op (idempotent upsert of an identical row).
  await execute(`UPDATE simforge.revisions SET content_sha256 = content_sha256 WHERE id = 'usrev_immutable'`);

  // 3. One-time fill of the materialized-traffic group, then never again.
  const fill = (digest: string) => execute(
    `UPDATE simforge.revisions SET materialized_traffic_artifact_id = 'usart_pin_xodr',
       materialized_traffic_sha256 = :sha, materialized_traffic_size_bytes = 1,
       materialized_traffic_source_input_digest = :sha
     WHERE id = 'usrev_immutable'`,
    { sha: digest },
  );
  await fill(SHA("c"));
  assert.match(await rejection(() => fill(SHA("d"))), /simforge_revision_immutable/);

  // 2. Account deletion nulls the author through ON DELETE SET NULL.
  await execute(
    `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
     VALUES ('user_gone', 'Gone', 'gone@local.simforge', TRUE, 'member')`,
  );
  await seedRevision({ workspaceId: LOCAL_WORKSPACE_ID, documentId: "usdoc_authored", revisionId: "usrev_authored", createdBy: "user_gone" });
  await execute(`DELETE FROM public.ba_user WHERE id = 'user_gone'`);
  const authored = await queryOne<{ created_by_user_id: string | null; content_sha256: string }>(
    `SELECT created_by_user_id, content_sha256 FROM simforge.revisions WHERE id = 'usrev_authored'`,
  );
  assert.deepEqual(authored, { created_by_user_id: null, content_sha256: SHA("a") });

  // Deleting the document still cascades to its revisions.
  await execute(`DELETE FROM simforge.documents WHERE id = 'usdoc_authored'`);
  assert.equal(await queryOne(`SELECT id FROM simforge.revisions WHERE id = 'usrev_authored'`), null);
});
