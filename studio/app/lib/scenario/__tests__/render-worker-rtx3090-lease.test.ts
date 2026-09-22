import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SIMFORGE_ENV = "dev";

import { LOCAL_HOST_TOKEN_ENV } from "@simforge-oss/studio-host/node";
import { loadBuiltinRenderEngine } from "@simforge-oss/render";
import { hashRenderIntent, PRONTO_CHASE_CAMERA_SENSOR, PRONTO_CHASE_CAMERA_SENSOR_ID } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../auth/session";
import { execute, queryOne, shutdownDatabase } from "../../db/data-api";
import { approveRenderWorker, renderWorkerApprovalError } from "../control-plane-store";
import { createRenderIntentJob } from "../render-intent-store";
import {
  claimResponseV2,
  registerRenderWorkerV2,
  reserveRenderArtifactV2,
  renderWorkerIdentity,
} from "../render-worker-control-store";
import { ScenarioRendererCapabilitySchema } from "../render-wire-contracts";
import { canonicalJsonSha256 } from "../core";

process.env[LOCAL_HOST_TOKEN_ENV] = "test-local-host-token";

/** A 3090 rented from vast.ai: not the local workstation node, dev environment. */
const WORKER_NODE_ID = "simforge-render-vast-3090-1";
const SOURCE_REVISION = "3".repeat(40);
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const REVISION_ID = "usrev_rtx3090";
const EXECUTION_PACKAGE_ID = "usepkg_rtx3090";
const DIGEST = (fill: string): string => fill.repeat(64);

const CARLA_LABELS = {
  imageDigest: IMAGE_DIGEST,
  hardwareProfile: "rtx3090-24gb-v1",
  gpuModel: "NVIDIA GeForce RTX 3090",
  gpuMemoryMiB: "24576",
  baseImage: "ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia",
  baseImageDigest: `sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5`,
  baseImagePlatformDigest: `sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64`,
} as const;

const FRONT_SENSOR = {
  id: "front",
  type: "dash_camera",
  label: "Front camera",
  mount: {
    position: { x: 1.6, y: 1.35, z: 0 },
    rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
  },
  camera: { horizontalFovDeg: 90, verticalFovDeg: 59, aspectRatio: 1.777778, nearM: 0.1, farM: 1_000 },
} as const;

/** The authored scenario the revision freezes: one rigged actor, a 20 s clip. */
const CANONICAL_CONTENT = {
  choreography: { clipSeconds: 20 },
  roles: [{ id: "ego", actor: { catalogId: "vehicle.sedan", sensors: [FRONT_SENSOR] } }],
};

function camera(sensorId: string, mount: unknown) {
  return {
    actorId: "ego",
    sensorId,
    outputName: `ego-${sensorId}`,
    modality: "rgb" as const,
    transform: mount,
    attributes: { width: 1920, height: 1080, fps: 30, horizontalFovDeg: 90, nearM: 0.1, farM: 1_000 },
  };
}

/** The two-camera 1080p shape the fleet is benchmarked on. */
const RENDER_SPEC = {
  schema: "simforge.render-spec/v3" as const,
  sources: [
    camera(FRONT_SENSOR.id, FRONT_SENSOR.mount),
    camera(PRONTO_CHASE_CAMERA_SENSOR_ID, PRONTO_CHASE_CAMERA_SENSOR.mount),
  ],
  clip: { startSeconds: 0, endSeconds: 20 },
  video: { width: 1920, height: 1080, fps: 30, container: "mp4" as const, codec: "h264" as const, quality: "high" as const },
  artifacts: ["manifest" as const, "video" as const],
  capabilityIntent: {
    required: ["sensor.rgb", "artifact.manifest", "artifact.video", "timing.fixed_step"],
    preferred: [],
    fidelity: "review" as const,
  },
  authoredEnvironment: { weather: "clear" as const, timeOfDay: "noon" as const, surfacePatches: [] },
};

/**
 * Artifacts must be attributable: either to an immutable revision, or to an
 * operational producer job (`uniscenario_artifacts_producer_closure_check`).
 * The asset-catalog manifest is seeded before the revision exists, so it takes
 * the producer-job form.
 */
async function artifact(
  id: string,
  kind: string,
  mediaType: string,
  digest: string,
  revisionId: string | null = REVISION_ID,
) {
  const provenance = revisionId
    ? { contract: "uniscenario.artifact-provenance/v1", producerRevisionId: revisionId }
    : {
      contract: "uniscenario.artifact-provenance/v1",
      producerJobFamily: "openscenario_compile",
      producerJobId: `seed-catalog:${id}`,
    };
  await execute(
    `INSERT INTO simforge.artifacts (
       id, workspace_id, revision_id, artifact_kind, media_type,
       storage_bucket, storage_key, sha256, byte_length, artifact_state,
       producer_job_family, producer_job_id, provenance
     ) VALUES (
       :id, :workspace_id, :revision_id, :kind, :media_type,
       'local-artifacts', :key, :sha256, 4096, 'available',
       :producer_family, :producer_job_id, CAST(:provenance AS jsonb)
     ) ON CONFLICT (id) DO NOTHING`,
    {
      id,
      workspace_id: LOCAL_WORKSPACE_ID,
      revision_id: revisionId,
      kind,
      media_type: mediaType,
      key: `rtx3090/${id}`,
      sha256: digest,
      producer_family: revisionId ? null : "openscenario_compile",
      producer_job_id: revisionId ? null : `seed-catalog:${id}`,
      provenance,
    },
  );
}

async function seedScenarioLineage() {
  await execute(
    `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
     VALUES (:id, 'Local Owner', 'owner@local.simforge', TRUE, 'owner')
     ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_USER_ID },
  );
  await execute(
    `INSERT INTO public.ba_organization (id, name, slug)
     VALUES (:id, 'Local Workspace', 'local') ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_ORGANIZATION_ID },
  );
  await execute(
    `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
     VALUES (:id, 'personal', 'local', 'Local Workspace', :user_id, :organization_id)
     ON CONFLICT (id) DO NOTHING`,
    { id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID, organization_id: LOCAL_ORGANIZATION_ID },
  );
  // The catalog manifest and the map's XODR predate the revision that will use
  // them, so they carry producer-job provenance rather than a revision scope;
  // a map_version cannot exist without either.
  await artifact("usart_catalog", "asset_catalog_manifest", "application/json", DIGEST("1"), null);
  await artifact("usart_xodr", "opendrive_xml", "application/xml", DIGEST("b"), null);
  await execute(
    `INSERT INTO simforge.asset_catalog_versions (
       id, workspace_id, contract_version, manifest_artifact_id, manifest_sha256,
       source_inventory_sha256, pipeline_version, toolchain, provenance
     ) VALUES (
       'usacv_rtx3090', :workspace_id, 'uniscenario.asset-catalog/v1', 'usart_catalog', :sha256,
       :inventory_sha256, 'asset-catalog@1.0.0', '{}'::jsonb, '{}'::jsonb
     ) ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID, sha256: DIGEST("1"), inventory_sha256: DIGEST("7") },
  );
  await execute(
    `INSERT INTO simforge.map_versions (
       id, workspace_id, source_map_id, label, browser_manifest_url, topology_artifact_url,
       xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256,
       descriptor, asset_catalog_version_id
     ) VALUES (
       'usmapv_rtx3090', :workspace_id, 'map-yale', 'Yale St', 'local://manifest', 'local://topology',
       'usart_xodr', :xodr_sha256, 'epsg:32610', :coordinate_sha256, '{}'::jsonb, 'usacv_rtx3090'
     ) ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID, xodr_sha256: DIGEST("b"), coordinate_sha256: DIGEST("c") },
  );
  await execute(
    `INSERT INTO simforge.datasets (id, workspace_id, name)
     VALUES ('usds_rtx3090', :workspace_id, 'rtx3090 bring-up')
     ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
  await execute(
    `INSERT INTO simforge.documents (id, workspace_id, dataset_id, title, schema_version, map_version_id)
     VALUES ('usdoc_rtx3090', :workspace_id, 'usds_rtx3090', 'Yale St', 'simforge.scenario/v1', 'usmapv_rtx3090')
     ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
  await execute(
    `INSERT INTO simforge.revisions (
       id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
       canonical_content, content_sha256, map_version_id, compiler_version
     ) VALUES (
       :revision_id, :workspace_id, 'usdoc_rtx3090', 1, 1, 'simforge.scenario/v1',
       CAST(:content AS jsonb), :content_sha256, 'usmapv_rtx3090', 'uniscenario-compiler@2.0.0'
     ) ON CONFLICT (id) DO NOTHING`,
    {
      revision_id: REVISION_ID,
      workspace_id: LOCAL_WORKSPACE_ID,
      content: CANONICAL_CONTENT,
      content_sha256: canonicalJsonSha256(CANONICAL_CONTENT),
    },
  );
  await artifact("usart_xosc", "openscenario_xml", "application/xml", DIGEST("e"));
  await artifact("usart_package", "execution_package_manifest", "application/json", DIGEST("2"));
  await artifact("usart_traffic", "materialized_traffic", "application/json", DIGEST("3"));
  await execute(
    `INSERT INTO simforge.execution_packages (
       id, workspace_id, revision_id, xosc_artifact_id, xodr_artifact_id,
       asset_catalog_version_id, package_artifact_id, manifest_sha256, xsd_sha256,
       runtime_contract_version, compiler_version, capability_profile,
       source_input_digest, ambient_mode, ambient_result_sha256,
       materialized_traffic_artifact_id, materialized_traffic_sha256,
       materialized_traffic_source_input_digest
     ) VALUES (
       :package_id, :workspace_id, :revision_id, 'usart_xosc', 'usart_xodr',
       'usacv_rtx3090', 'usart_package', :manifest_sha256, :xsd_sha256,
       'simforge.execution-package/v1', 'uniscenario-compiler@2.0.0', 'xml-1.4-trajectory-replay',
       :source_input_digest, 'disabled', :ambient_sha256,
       'usart_traffic', :ambient_sha256, :source_input_digest
     ) ON CONFLICT (id) DO NOTHING`,
    {
      package_id: EXECUTION_PACKAGE_ID,
      workspace_id: LOCAL_WORKSPACE_ID,
      revision_id: REVISION_ID,
      manifest_sha256: DIGEST("2"),
      xsd_sha256: DIGEST("4"),
      source_input_digest: DIGEST("5"),
      ambient_sha256: DIGEST("6"),
    },
  );
}

/**
 * A truthful RTX 3090 CARLA worker must be able to travel the whole admission
 * path: identity, operator approval, registration, and a lease. Before the
 * `rtx3090-24gb-v1` profile existed, `renderWorkerIdentity` threw
 * `worker_hardware_profile_incompatible` at the first step, and the CARLA
 * engine's `engineVersion` of `native-v1` failed approval with
 * `worker_version_invalid` at the second.
 */
test("an RTX 3090 CARLA worker registers and leases a queued render job", async (t) => {
  t.after(() => shutdownDatabase());
  await migrate();
  await seedScenarioLineage();

  // The engine declaration the worker really presents, not a hand-written one.
  const engine = await loadBuiltinRenderEngine("carla", { engineVersion: SOURCE_REVISION });
  const capability = ScenarioRendererCapabilitySchema.parse(engine.capabilities);
  assert.equal(capability.engineVersion, SOURCE_REVISION);

  const identity = renderWorkerIdentity(capability, { ...CARLA_LABELS });
  assert.equal(identity.hardwareProfile, "rtx3090-24gb-v1");
  assert.equal(identity.metadata.gpuMemoryMiB, 24_576);
  assert.equal(
    renderWorkerApprovalError({ workerNodeId: WORKER_NODE_ID, environment: "dev", identity }),
    null,
  );

  const approval = await approveRenderWorker(WORKER_NODE_ID, {
    engine: capability,
    labels: { ...CARLA_LABELS },
    reason: "rented 3090 bring-up",
  });
  assert.equal(approval?.approved.hardwareProfile, "rtx3090-24gb-v1");

  const registration = await registerRenderWorkerV2({
    workerId: WORKER_NODE_ID,
    instanceId: "vast-instance-1",
    engine: capability,
    labels: { ...CARLA_LABELS },
  });
  assert.match(registration.registrationId, /^uswr_/);

  // Idle workers must remain discoverable without a queued compatible job.
  await execute(
    `UPDATE simforge.worker_nodes SET last_heartbeat_at = to_timestamp(0),
       last_idle_heartbeat_at = to_timestamp(0) WHERE id = :id`,
    { id: WORKER_NODE_ID },
  );
  assert.equal((await claimResponseV2("stale-registration", WORKER_NODE_ID)).type, "job.none");
  assert.equal((await queryOne<{ fresh: boolean }>(
    `SELECT last_heartbeat_at > to_timestamp(0) AS fresh FROM simforge.worker_nodes WHERE id = :id`,
    { id: WORKER_NODE_ID },
  ))?.fresh, false, "a stale registration cannot keep a node alive");
  assert.equal((await claimResponseV2(registration.registrationId, WORKER_NODE_ID)).type, "job.none");
  assert.deepEqual(await queryOne(
    `SELECT last_heartbeat_at >= NOW() - INTERVAL '90 seconds' AS live,
       last_idle_heartbeat_at >= NOW() - INTERVAL '90 seconds' AS idle
       FROM simforge.worker_nodes WHERE id = :id`,
    { id: WORKER_NODE_ID },
  ), { live: true, idle: true });

  const job = await createRenderIntentJob(
    { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID },
    {
      schema: "simforge.submit-render-intent/v1",
      revisionId: REVISION_ID,
      executionPackageId: EXECUTION_PACKAGE_ID,
      engine: "carla",
      renderSpec: RENDER_SPEC,
      idempotencyKey: "rtx3090-lease-test",
    } as Parameters<typeof createRenderIntentJob>[1],
  );
  assert.ok(job, "the render intent must enqueue against the seeded lineage");

  const lease = await claimResponseV2(registration.registrationId, WORKER_NODE_ID);
  assert.equal(lease.type, "job.leased");
  assert.equal("jobId" in lease ? lease.jobId : null, job.id);
  assert.ok("lease" in lease && lease.lease.fenceToken.length >= 32);
  assert.ok("intent" in lease && "intentSha256" in lease);
  assert.equal(hashRenderIntent(lease.intent), lease.intentSha256, "the worker must accept the leased multi-camera intent digest");
  const reservation = await reserveRenderArtifactV2({
    jobId: job.id,
    leaseId: lease.lease.leaseId,
    fenceToken: lease.lease.fenceToken,
    workerNodeId: WORKER_NODE_ID,
    identity: { role: "video", actorId: "ego", sensorId: FRONT_SENSOR.id, modality: "rgb" },
    sha256: DIGEST("9"),
    sizeBytes: 4096,
    mediaType: "video/mp4",
  });
  assert.ok(reservation, "the active worker can reserve its camera artifact");
  const reservedAttempt = await queryOne<{ matches: boolean }>(
    `SELECT u.render_attempt_id = l.render_attempt_id AS matches
       FROM simforge.artifact_uploads u JOIN simforge.worker_leases l ON l.id = :lease_id
      WHERE u.id = :artifact_id`,
    { lease_id: lease.lease.leaseId, artifact_id: reservation.artifactId },
  );
  assert.equal(reservedAttempt?.matches, true, "the upload is fenced to the leased attempt");

  // The lease is real in the ledger: the trigger that refuses ineligible
  // hardware profiles let it through.
  const persisted = await queryOne<{ workspace_id: string; worker_node_id: string; lease_state: string }>(
    `SELECT workspace_id, worker_node_id, lease_state FROM simforge.worker_leases WHERE render_job_id = :job_id`,
    { job_id: job.id },
  );
  assert.deepEqual(persisted, {
    workspace_id: LOCAL_WORKSPACE_ID, worker_node_id: WORKER_NODE_ID, lease_state: "active",
  });
});

test("the profile gate still refuses hardware that does not match its name", async () => {
  const engine = await loadBuiltinRenderEngine("carla", { engineVersion: SOURCE_REVISION });
  const capability = ScenarioRendererCapabilitySchema.parse(engine.capabilities);

  // vast.ai advertises 20480 MiB boards as 3090s; that card is not a 24 GiB one.
  assert.throws(
    () => renderWorkerIdentity(capability, { ...CARLA_LABELS, gpuMemoryMiB: "20480" }),
    /worker_gpu_capability_invalid/,
  );
  assert.throws(
    () => renderWorkerIdentity(capability, { ...CARLA_LABELS, hardwareProfile: "rtx3090-24gb-v1b-v9" }),
    /worker_hardware_profile_incompatible/,
  );
});

test("CARLA approval still demands a source revision, never a package label", async () => {
  await assert.rejects(
    loadBuiltinRenderEngine("carla", { engineVersion: "native-v1" }),
    /40-hex source revision/,
  );
  const identity = renderWorkerIdentity(
    ScenarioRendererCapabilitySchema.parse({
      ...(await loadBuiltinRenderEngine("carla", { engineVersion: SOURCE_REVISION })).capabilities,
      engineVersion: "0.1.0-rc.65",
    }),
    { ...CARLA_LABELS },
  );
  assert.equal(
    renderWorkerApprovalError({ workerNodeId: WORKER_NODE_ID, environment: "dev", identity }),
    "worker_version_invalid",
  );
});
