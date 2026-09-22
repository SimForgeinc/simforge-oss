import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import { LOCAL_HOST_TOKEN_ENV } from "@simforge-oss/studio-host/node";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../auth/session";
import { execute, queryRows, shutdownDatabase } from "../../db/data-api";
import { writeLocalObject } from "../../s3/s3-object";
import { MATERIALIZED_TRAFFIC_RESERVATION_SQL } from "../materialized-traffic-binding";
import { completeMaterializedTraffic, reserveMaterializedTrafficBytes } from "../materialized-traffic-store";

/**
 * Materialized-traffic bytes are content-addressed and shared between
 * documents. Two defects lived on the dedupe path:
 * - a reservation of bytes that were already published opened a producer job
 *   that nothing ever closed (the report's stuck `uspp_bbc5a1bf…`);
 * - it rewrote the shared blob's `metadata.documentId`, re-binding bytes that
 *   another document had already committed to.
 */
process.env[LOCAL_HOST_TOKEN_ENV] ??= "materialized-traffic-store-test";

before(async () => {
  await migrate();
  await seedWorkspace();
});
after(() => shutdownDatabase());

const context = { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID };
const bytes = new TextEncoder().encode('{"traffic":"shared"}');
const sha256 = createHash("sha256").update(bytes).digest("hex");
const reservation = (expectedVersion: number) => ({
  expectedVersion,
  sha256,
  sizeBytes: bytes.byteLength,
  sourceInputDigest: "d".repeat(64),
  mapAssetId: "map-asset",
  mapVersionId: "map-version",
});

async function seedWorkspace() {
  await execute(
    `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
     VALUES (:id, 'Local Owner', 'owner@local.simforge', TRUE, 'owner') ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_USER_ID },
  );
  await execute(
    `INSERT INTO public.ba_organization (id, name, slug) VALUES (:id, 'Local Workspace', 'local') ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_ORGANIZATION_ID },
  );
  await execute(
    `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
     VALUES (:id, 'personal', 'local', 'Local Workspace', :user_id, :organization_id) ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID, organization_id: LOCAL_ORGANIZATION_ID },
  );
}

async function jobs() {
  return queryRows<{ document_id: string; state: string }>(
    `SELECT request_payload->>'documentId' AS document_id, state FROM simforge.artifact_postprocess_jobs
      WHERE workspace_id = :workspace_id AND postprocess_kind = 'materialize_traffic' ORDER BY document_id, created_at`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
}

async function boundTo(documentId: string) {
  const rows = await queryRows<{ id: string }>(
    `SELECT j.id FROM simforge.artifact_postprocess_jobs j
      WHERE j.workspace_id = :workspace_id AND j.state = 'succeeded' AND ${MATERIALIZED_TRAFFIC_RESERVATION_SQL}`,
    {
      workspace_id: LOCAL_WORKSPACE_ID, document_id: documentId, sha256,
      source_input_digest: "d".repeat(64), map_asset_id: "map-asset", map_version_id: "map-version",
    },
  );
  return rows.length > 0;
}

test("deduplicated materialized traffic closes every reservation and never re-binds the shared blob", async () => {

  // Document A produces the bytes.
  const first = await reserveMaterializedTrafficBytes(context, "uscn_a", reservation(3));
  assert.equal(first.uploadRequired, true);
  const [pending] = await queryRows<{ storage_bucket: string; storage_key: string }>(
    `SELECT storage_bucket, storage_key FROM simforge.artifacts WHERE id = :id`, { id: first.artifactId },
  );
  await writeLocalObject(pending!.storage_bucket, pending!.storage_key, bytes, "application/json");
  const reference = { ...reservation(3), artifactId: first.artifactId };
  delete (reference as { expectedVersion?: number }).expectedVersion;
  assert.ok(await completeMaterializedTraffic(context, "uscn_a", reference));
  assert.deepEqual(await jobs(), [{ document_id: "uscn_a", state: "succeeded" }]);

  // Document B reserves identical bytes: nothing to upload, nothing left running.
  const second = await reserveMaterializedTrafficBytes(context, "uscn_b", reservation(7));
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(second.uploadRequired, false);
  assert.equal(second.uploadUrl, null);
  assert.deepEqual((await jobs()).map((job) => job.state), ["succeeded", "succeeded"]);
  // Completing it (the client always completes) is accepted and idempotent.
  assert.ok(await completeMaterializedTraffic(context, "uscn_b", reference));
  assert.ok(await completeMaterializedTraffic(context, "uscn_a", reference));

  // The shared row still names its producer; both documents are bound by their own reservation.
  const [row] = await queryRows<{ document_id: string }>(
    `SELECT metadata->>'documentId' AS document_id FROM simforge.artifacts WHERE id = :id`, { id: first.artifactId },
  );
  assert.equal(row!.document_id, "uscn_a");
  assert.equal(await boundTo("uscn_a"), true);
  assert.equal(await boundTo("uscn_b"), true);
  assert.equal(await boundTo("uscn_never_reserved"), false);
  // A document that never reserved these bytes cannot complete against them.
  assert.equal(await completeMaterializedTraffic(context, "uscn_never_reserved", reference), null);
  assert.equal((await jobs()).filter((job) => job.state === "running").length, 0);
});

test("two documents reserving identical bytes while both are pending both finish closed", async () => {
  const other = new TextEncoder().encode('{"traffic":"concurrent"}');
  const otherSha = createHash("sha256").update(other).digest("hex");
  const input = (expectedVersion: number) => ({ ...reservation(expectedVersion), sha256: otherSha, sizeBytes: other.byteLength });

  const a = await reserveMaterializedTrafficBytes(context, "uscn_c", input(1));
  const b = await reserveMaterializedTrafficBytes(context, "uscn_d", input(1));
  assert.equal(a.artifactId, b.artifactId);
  assert.equal(b.uploadRequired, true);
  const [pending] = await queryRows<{ storage_bucket: string; storage_key: string }>(
    `SELECT storage_bucket, storage_key FROM simforge.artifacts WHERE id = :id`, { id: a.artifactId },
  );
  await writeLocalObject(pending!.storage_bucket, pending!.storage_key, other, "application/json");
  const reference = { artifactId: a.artifactId, sha256: otherSha, sizeBytes: other.byteLength, sourceInputDigest: "d".repeat(64), mapAssetId: "map-asset", mapVersionId: "map-version" };
  // The FIRST reserver completes; its job was displaced as the row's producer by the second.
  assert.ok(await completeMaterializedTraffic(context, "uscn_c", reference));
  assert.ok(await completeMaterializedTraffic(context, "uscn_d", reference));
  const states = await queryRows<{ document_id: string; state: string }>(
    `SELECT request_payload->>'documentId' AS document_id, state FROM simforge.artifact_postprocess_jobs
      WHERE workspace_id = :workspace_id AND request_payload->>'sha256' = :sha ORDER BY 1`,
    { workspace_id: LOCAL_WORKSPACE_ID, sha: otherSha },
  );
  assert.deepEqual(states, [{ document_id: "uscn_c", state: "succeeded" }, { document_id: "uscn_d", state: "succeeded" }]);
});
