import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { LOCAL_HOST_TOKEN_ENV } from "@simforge-oss/studio-host/node";

import { migrate } from "../../../../scripts/migrate";
import type { AppContext } from "../../db/app-context";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../auth/session";
import { execute, queryRows, shutdownDatabase } from "../../db/data-api";
import { writeLocalObject } from "../../s3/s3-object";
import { simulationPreviewEngine } from "../simulation-preview-engine";
import {
  completeSimulationPreview,
  getCurrentSimulationPreview,
  reserveSimulationPreview,
} from "../simulation-preview-store";

process.env[LOCAL_HOST_TOKEN_ENV] ??= "simulation-preview-engine-test";

const preview = (engineVersion: string, headerVersion = engineVersion) => ({
  schema: "simforge.uniscenario-browser-preview/v3",
  draftVersion: 4,
  engine: { engineVersion, engineSemVer: engineVersion, abiVersion: 3 },
  mapClosureSha256: "e".repeat(64),
  instance: {},
  trace: { header: { engineVersion: headerVersion } },
});

describe("simulationPreviewEngine", () => {
  test("reads the engine a saved simulation records", () => {
    assert.deepEqual(simulationPreviewEngine(preview("0.8.0")), { engineSemVer: "0.8.0", abiVersion: 3 });
  });
  test("pre-0.8.0 documents record the semantics version as engineVersion", () => {
    const legacy = { engine: { engineVersion: "0.7.0", abiVersion: 3 }, trace: { header: { engineVersion: "0.7.0" } } };
    assert.deepEqual(simulationPreviewEngine(legacy), { engineSemVer: "0.7.0", abiVersion: 3 });
  });
  test("an inconsistent or missing identity is no identity", () => {
    assert.equal(simulationPreviewEngine(preview("0.8.0", "0.7.0")), null);
    assert.equal(simulationPreviewEngine({ trace: { header: { engineVersion: "0.8.0" } } }), null);
    assert.equal(simulationPreviewEngine(null), null);
  });
});

const context = { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID } as AppContext;
const DOCUMENT = "uscn_engine_scope";

before(async () => {
  await migrate();
  await execute(
    `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
     VALUES (:id, 'Local Owner', 'owner@local.simforge', TRUE, 'owner') ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_USER_ID },
  );
  await execute(`INSERT INTO public.ba_organization (id, name, slug) VALUES (:id, 'Local Workspace', 'local') ON CONFLICT (id) DO NOTHING`, { id: LOCAL_ORGANIZATION_ID });
  await execute(
    `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
     VALUES (:id, 'personal', 'local', 'Local Workspace', :user_id, :organization_id) ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID, organization_id: LOCAL_ORGANIZATION_ID },
  );
  // The map version, document and draft are scaffolding for the joins under
  // test; their own foreign keys (datasets, catalogs, map artifacts) are not.
  await execute("SET session_replication_role = replica");
  await execute(
    `INSERT INTO simforge.map_versions (id, workspace_id, label, browser_manifest_url, topology_artifact_url, xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256, asset_catalog_version_id)
     VALUES ('mv_engine', :ws, 'Map', 'x', 'x', 'art_x', :sha, 'cs', :sha, 'cat')`,
    { ws: LOCAL_WORKSPACE_ID, sha: "a".repeat(64) },
  );
  await execute(
    `INSERT INTO simforge.documents (id, workspace_id, title, schema_version, dataset_id) VALUES (:id, :ws, 'Doc', 'v2', 'ds')`,
    { id: DOCUMENT, ws: LOCAL_WORKSPACE_ID },
  );
  await execute(
    `INSERT INTO simforge.drafts (document_id, workspace_id, schema_version, canonical_content, content_sha256, draft_version, map_version_id)
     VALUES (:id, :ws, 'v2', '{}'::jsonb, :sha, 4, 'mv_engine')`,
    { id: DOCUMENT, ws: LOCAL_WORKSPACE_ID, sha: "c".repeat(64) },
  );
  await execute("SET session_replication_role = origin");
});
after(() => shutdownDatabase());

async function save(document: unknown) {
  const bytes = gzipSync(Buffer.from(JSON.stringify(document)));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const reservation = await reserveSimulationPreview(context, DOCUMENT, { expectedVersion: 4, sha256, sizeBytes: bytes.byteLength });
  assert.ok(reservation);
  const [row] = await queryRows<{ storage_bucket: string; storage_key: string }>(
    "SELECT storage_bucket, storage_key FROM simforge.artifacts WHERE id = :id", { id: reservation.artifactId },
  );
  await writeLocalObject(row!.storage_bucket, row!.storage_key, bytes, "application/gzip");
  assert.deepEqual(
    await completeSimulationPreview(context, DOCUMENT, { expectedVersion: 4, sha256, sizeBytes: bytes.byteLength, artifactId: reservation.artifactId }),
    { ok: true },
  );
}

describe("getCurrentSimulationPreview is scoped to engine semantics", () => {
  test("a run saved by the current engine is current; the same run is stale for a newer engine", async () => {
    await save(preview("0.8.0"));
    assert.equal((await getCurrentSimulationPreview(context, DOCUMENT, { engineSemVer: "0.8.0", abiVersion: 3 }))?.draftVersion, 4);
    assert.equal(await getCurrentSimulationPreview(context, DOCUMENT, { engineSemVer: "0.9.0", abiVersion: 3 }), null);
    assert.equal(await getCurrentSimulationPreview(context, DOCUMENT, { engineSemVer: "0.8.0", abiVersion: 4 }), null);
    // No native engine on the host: only the engine scope is skipped.
    assert.ok(await getCurrentSimulationPreview(context, DOCUMENT, null));
  });

  test("a run saved by an older engine is not current, however recent", async () => {
    await save(preview("0.7.0"));
    assert.equal(await getCurrentSimulationPreview(context, DOCUMENT, { engineSemVer: "0.8.0", abiVersion: 3 }), null);
  });

  test("a run whose bytes record no consistent engine is never current", async () => {
    await save(preview("0.8.0", "0.7.0"));
    assert.equal(await getCurrentSimulationPreview(context, DOCUMENT, { engineSemVer: "0.8.0", abiVersion: 3 }), null);
    assert.equal(await getCurrentSimulationPreview(context, DOCUMENT, { engineSemVer: "0.7.0", abiVersion: 3 }), null);
  });
});
