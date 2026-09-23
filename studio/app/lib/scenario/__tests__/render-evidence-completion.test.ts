import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

process.env.SIMFORGE_ENV = "dev";

import { LOCAL_HOST_TOKEN_ENV } from "@simforge-oss/studio-host/node";
import { CONTROL_FEATURES_V1, loadBuiltinRenderEngine } from "@simforge-oss/render";
import { hashRenderIntent } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../auth/session";
import type { AppContext } from "../../db/app-context";
import { execute, queryOne, shutdownDatabase } from "../../db/data-api";
import { writeLocalObject } from "../../s3/s3-object";
import { approveRenderWorker } from "../control-plane-store";
import { createRenderIntentJob } from "../render-intent-store";
import { getRenderJobDetail, publicFailureDetail, publicRenderSubstitutions, publicRenderWarnings } from "../render/detail-store";
import {
  appendRenderProgressV2,
  claimResponseV2,
  completeRenderJobV2,
  failRenderJobV2,
  leaseControlFeatures,
  registerRenderWorkerV2,
  RenderEvidenceRejectedError,
  reserveRenderArtifactV2,
} from "../render-worker-control-store";
import { ScenarioRendererCapabilitySchema } from "../render-wire-contracts";
import { canonicalJsonSha256 } from "../core";

process.env[LOCAL_HOST_TOKEN_ENV] = "test-local-host-token";

/**
 * The control plane is the last line of defence of the no-silent-fallbacks
 * policy (docs/engineering/no-silent-fallbacks.md): a CARLA completion whose
 * evidence records a degradation fails the job, non-retryable, with a code
 * and message that name it; an exact render with an allowed, recorded
 * substitution succeeds and the job result shows the substitution and the
 * engine's warnings.
 */

const WORKER_NODE_ID = "simforge-render-evidence-carla-1";
const SOURCE_REVISION = "3".repeat(40);
const REVISION_ID = "usrev_evidence";
const EXECUTION_PACKAGE_ID = "usepkg_evidence";
const DIGEST = (fill: string): string => fill.repeat(64);
const CONTEXT = { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID, organizationId: LOCAL_ORGANIZATION_ID } as AppContext;

const CARLA_LABELS = {
  imageDigest: `sha256:${"a".repeat(64)}`,
  hardwareProfile: "rtx3090-24gb-v1",
  gpuModel: "NVIDIA GeForce RTX 3090",
  gpuMemoryMiB: "24576",
  baseImage: "ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia",
  baseImageDigest: `sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5`,
  baseImagePlatformDigest: `sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64`,
  // Leases then list every CONTROL_FEATURES_V1 feature, including render-evidence.substitutions.
  controlFeatures: "v1",
} as const;

const FRONT_SENSOR = {
  id: "front",
  type: "dash_camera",
  label: "Front camera",
  mount: { position: { x: 1.6, y: 1.35, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
  camera: { horizontalFovDeg: 90, verticalFovDeg: 59, aspectRatio: 1.777778, nearM: 0.1, farM: 1_000 },
} as const;
const CANONICAL_CONTENT = {
  choreography: { clipSeconds: 4 },
  roles: [{ id: "ego", actor: { catalogId: "vehicle.sedan", sensors: [FRONT_SENSOR] } }],
};
const RENDER_SPEC = {
  schema: "simforge.render-spec/v3" as const,
  sources: [{
    actorId: "ego", sensorId: FRONT_SENSOR.id, outputName: `ego-${FRONT_SENSOR.id}`, modality: "rgb" as const,
    transform: FRONT_SENSOR.mount,
    attributes: { width: 1280, height: 720, fps: 20, horizontalFovDeg: 90, nearM: 0.1, farM: 1_000 },
  }],
  clip: { startSeconds: 0, endSeconds: 4 },
  video: { width: 1280, height: 720, fps: 20, container: "mp4" as const, codec: "h264" as const, quality: "high" as const },
  artifacts: ["manifest" as const, "video" as const],
  capabilityIntent: {
    required: ["sensor.rgb", "artifact.manifest", "artifact.video", "timing.fixed_step"],
    preferred: [],
    fidelity: "review" as const,
  },
  authoredEnvironment: { weather: "clear" as const, timeOfDay: "noon" as const, surfacePatches: [] },
};

async function artifact(id: string, kind: string, mediaType: string, digest: string, revisionId: string | null = REVISION_ID) {
  const provenance = revisionId
    ? { contract: "uniscenario.artifact-provenance/v1", producerRevisionId: revisionId }
    : { contract: "uniscenario.artifact-provenance/v1", producerJobFamily: "openscenario_compile", producerJobId: `seed-catalog:${id}` };
  await execute(
    `INSERT INTO simforge.artifacts (
       id, workspace_id, revision_id, artifact_kind, media_type, storage_bucket, storage_key, sha256, byte_length,
       artifact_state, producer_job_family, producer_job_id, provenance
     ) VALUES (
       :id, :workspace_id, :revision_id, :kind, :media_type, 'local-artifacts', :key, :sha256, 4096,
       'available', :producer_family, :producer_job_id, CAST(:provenance AS jsonb)
     ) ON CONFLICT (id) DO NOTHING`,
    {
      id, workspace_id: LOCAL_WORKSPACE_ID, revision_id: revisionId, kind, media_type: mediaType, key: `evidence/${id}`,
      sha256: digest, producer_family: revisionId ? null : "openscenario_compile",
      producer_job_id: revisionId ? null : `seed-catalog:${id}`, provenance,
    },
  );
}

async function seedScenarioLineage() {
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
  await artifact("usart_catalog", "asset_catalog_manifest", "application/json", DIGEST("1"), null);
  await artifact("usart_xodr", "opendrive_xml", "application/xml", DIGEST("b"), null);
  await execute(
    `INSERT INTO simforge.asset_catalog_versions (
       id, workspace_id, contract_version, manifest_artifact_id, manifest_sha256,
       source_inventory_sha256, pipeline_version, toolchain, provenance
     ) VALUES (
       'usacv_evidence', :workspace_id, 'uniscenario.asset-catalog/v1', 'usart_catalog', :sha256,
       :inventory_sha256, 'asset-catalog@1.0.0', '{}'::jsonb, '{}'::jsonb
     ) ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID, sha256: DIGEST("1"), inventory_sha256: DIGEST("7") },
  );
  await execute(
    `INSERT INTO simforge.map_versions (
       id, workspace_id, source_map_id, label, browser_manifest_url, topology_artifact_url,
       xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256, descriptor, asset_catalog_version_id
     ) VALUES (
       'usmapv_evidence', :workspace_id, 'map-yale', 'Yale St', 'local://manifest', 'local://topology',
       'usart_xodr', :xodr_sha256, 'epsg:32610', :coordinate_sha256, '{}'::jsonb, 'usacv_evidence'
     ) ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID, xodr_sha256: DIGEST("b"), coordinate_sha256: DIGEST("c") },
  );
  await execute(
    `INSERT INTO simforge.datasets (id, workspace_id, name) VALUES ('usds_evidence', :workspace_id, 'evidence') ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
  await execute(
    `INSERT INTO simforge.documents (id, workspace_id, dataset_id, title, schema_version, map_version_id)
     VALUES ('usdoc_evidence', :workspace_id, 'usds_evidence', 'Yale St', 'simforge.scenario/v1', 'usmapv_evidence')
     ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
  await execute(
    `INSERT INTO simforge.revisions (
       id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
       canonical_content, content_sha256, map_version_id, compiler_version
     ) VALUES (
       :revision_id, :workspace_id, 'usdoc_evidence', 1, 1, 'simforge.scenario/v1',
       CAST(:content AS jsonb), :content_sha256, 'usmapv_evidence', 'uniscenario-compiler@2.0.0'
     ) ON CONFLICT (id) DO NOTHING`,
    { revision_id: REVISION_ID, workspace_id: LOCAL_WORKSPACE_ID, content: CANONICAL_CONTENT, content_sha256: canonicalJsonSha256(CANONICAL_CONTENT) },
  );
  await artifact("usart_xosc", "openscenario_xml", "application/xml", DIGEST("e"));
  await artifact("usart_package", "execution_package_manifest", "application/json", DIGEST("2"));
  await artifact("usart_traffic", "materialized_traffic", "application/json", DIGEST("3"));
  await execute(
    `INSERT INTO simforge.execution_packages (
       id, workspace_id, revision_id, xosc_artifact_id, xodr_artifact_id, asset_catalog_version_id, package_artifact_id,
       manifest_sha256, xsd_sha256, runtime_contract_version, compiler_version, capability_profile,
       source_input_digest, ambient_mode, ambient_result_sha256,
       materialized_traffic_artifact_id, materialized_traffic_sha256, materialized_traffic_source_input_digest
     ) VALUES (
       :package_id, :workspace_id, :revision_id, 'usart_xosc', 'usart_xodr', 'usacv_evidence', 'usart_package',
       :manifest_sha256, :xsd_sha256, 'simforge.execution-package/v1', 'uniscenario-compiler@2.0.0', 'xml-1.4-trajectory-replay',
       :source_input_digest, 'disabled', :ambient_sha256, 'usart_traffic', :ambient_sha256, :source_input_digest
     ) ON CONFLICT (id) DO NOTHING`,
    {
      package_id: EXECUTION_PACKAGE_ID, workspace_id: LOCAL_WORKSPACE_ID, revision_id: REVISION_ID,
      manifest_sha256: DIGEST("2"), xsd_sha256: DIGEST("4"), source_input_digest: DIGEST("5"), ambient_sha256: DIGEST("6"),
    },
  );
}

type Lease = Extract<Awaited<ReturnType<typeof claimResponseV2>>, { type: "job.leased" }>;

function replayEvidence(lease: Lease, overrides: { trajectory?: Record<string, unknown>; execution?: Record<string, unknown> } = {}) {
  return {
    schema: "uniscenario.parity-evidence/v1",
    identity: {
      revisionId: REVISION_ID,
      executionPackageId: EXECUTION_PACKAGE_ID,
      executionPackageControlSha256: lease.executionPackageControlSha256,
      sourceInputDigest: DIGEST("5"),
      planSha256: DIGEST("8"),
    },
    execution: { mode: "trace-replay", purpose: "scenario-render", fixedTimestepS: 0.02, mapBinding: "exact", ...overrides.execution },
    semantics: { verdict: "pass", evaluatedInteractionCount: 0, unclassifiedDifferenceCount: 0, failedCheckIds: [] },
    trajectory: {
      verdict: "pass", acceptanceGate: "replay-sampler-parity", evaluatedActorCount: 2, failedActorIds: [],
      droppedActorIds: [], nudgedActorIds: [], postContactFailedActorIds: [], postContactClassification: "not-applicable",
      metrics: { "max.positionM": 0.0003, "max.rotationDeg": 0.01 },
      ...overrides.trajectory,
    },
    collisions: { verdict: "pass", source: "timeline", evaluatedPairCount: 0, failedPairs: [] },
    artifacts: { verdict: "pass", verifiedKinds: ["manifest", "video"], missingKinds: [] },
    divergences: [],
    verdict: "pass",
  };
}

function exactAttestation(overrides: Record<string, unknown> = {}, runtime: Record<string, unknown> = {}) {
  return {
    schema: "simforge.worker-attestation/v1",
    workerImageDigest: CARLA_LABELS.imageDigest,
    workerRevision: SOURCE_REVISION,
    executionMode: "trace-replay",
    purpose: "scenario-render",
    scenarioRender: true,
    workerIdentityComplete: true,
    runtimeEvidence: {
      schema: "simforge.carla-runtime-evidence/v1",
      available: true,
      purpose: "scenario-render",
      map: {
        schema: "simforge.carla-map-evidence/v1", available: true, source: "cooked-custom-map",
        identityMode: "xodr-byte-exact", binding: "exact", exact: true, loadedMapName: "yale_st",
      },
      environment: { schema: "simforge.environment-evidence/v1", available: true, exact: true },
      runtimeImage: { exact: true, configuredManifestSha256: "baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64" },
      ...runtime,
    },
    ...overrides,
  };
}

/**
 * The executor's `manifest.json`. A current executor records body
 * substitutions in `substitutions`; rc.73 listed them in
 * `carlaVehicleFallbacks` (pass `substitutions: null` for that shape).
 */
function carlaManifest(lease: Lease, parts: {
  evidence?: unknown;
  attestation?: unknown;
  carlaVehicleFallbacks?: unknown[];
  substitutions?: unknown[] | null;
} = {}) {
  return {
    schema: "simforge.render-manifest/v1",
    jobId: lease.jobId,
    executionPackageId: EXECUTION_PACKAGE_ID,
    executionPackageControlSha256: lease.executionPackageControlSha256,
    xoscValidation: {
      valid: true, standardVersion: "1.4.0",
      xmlSha256: lease.intent.scenarioRevision.openScenario.sha256, xsdSha256: DIGEST("4"),
    },
    workerAttestation: parts.attestation ?? exactAttestation(),
    parityEvidence: parts.evidence ?? replayEvidence(lease),
    ...(parts.carlaVehicleFallbacks ? { carlaVehicleFallbacks: parts.carlaVehicleFallbacks } : {}),
    ...(parts.substitutions === null ? {} : { substitutions: parts.substitutions ?? [] }),
  };
}

let sequence = 0;

/** Enqueue a CARLA render, lease it and upload a manifest and video, as a worker would. */
async function leasedJob(options: { allowSubstitutions?: string[] } = {}): Promise<Lease> {
  sequence += 1;
  const job = await createRenderIntentJob(
    { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID },
    {
      schema: "simforge.submit-render-intent/v1", revisionId: REVISION_ID, executionPackageId: EXECUTION_PACKAGE_ID,
      engine: "carla", renderSpec: RENDER_SPEC, idempotencyKey: `render-evidence-${sequence}`,
    } as Parameters<typeof createRenderIntentJob>[1],
  );
  assert.ok(job);
  if (options.allowSubstitutions) {
    const stored = await queryOne<{ intent: string }>(`SELECT render_intent::text AS intent FROM simforge.render_jobs WHERE id = :id`, { id: job.id });
    const intent = { ...JSON.parse(stored!.intent), allowSubstitutions: options.allowSubstitutions };
    await execute(
      `UPDATE simforge.render_jobs SET render_intent = CAST(:intent AS jsonb), intent_sha256 = :sha WHERE id = :id`,
      { id: job.id, intent: JSON.stringify(intent), sha: hashRenderIntent(intent) },
    );
  }
  const lease = await claimResponseV2((await registration()).registrationId, WORKER_NODE_ID);
  assert.equal(lease.type, "job.leased");
  assert.equal((lease as Lease).jobId, job.id);
  return lease as Lease;
}

let registered: { registrationId: string } | undefined;
async function registration() {
  if (registered) return registered;
  const engine = await loadBuiltinRenderEngine("carla", { engineVersion: SOURCE_REVISION });
  const capability = ScenarioRendererCapabilitySchema.parse(engine.capabilities);
  await approveRenderWorker(WORKER_NODE_ID, { engine: capability, labels: { ...CARLA_LABELS }, reason: "evidence policy test" });
  registered = await registerRenderWorkerV2({ workerId: WORKER_NODE_ID, instanceId: "evidence-1", engine: capability, labels: { ...CARLA_LABELS } });
  return registered;
}

async function complete(lease: Lease, manifest: unknown) {
  const uploads: Array<{ identity: Parameters<typeof reserveRenderArtifactV2>[0]["identity"]; bytes: Buffer; mediaType: string }> = [
    { identity: { role: "manifest", actorId: null, sensorId: null, modality: null }, bytes: Buffer.from(JSON.stringify(manifest)), mediaType: "application/json" },
    { identity: { role: "video", actorId: "ego", sensorId: FRONT_SENSOR.id, modality: "rgb" }, bytes: Buffer.from(`video-${lease.jobId}`), mediaType: "video/mp4" },
  ];
  const artifacts = [];
  for (const upload of uploads) {
    const sha = createHash("sha256").update(upload.bytes).digest("hex");
    const reservation = await reserveRenderArtifactV2({
      jobId: lease.jobId, leaseId: lease.lease.leaseId, fenceToken: lease.lease.fenceToken, workerNodeId: WORKER_NODE_ID,
      identity: upload.identity, sha256: sha, sizeBytes: upload.bytes.byteLength, mediaType: upload.mediaType,
    });
    assert.ok(reservation);
    const stored = await queryOne<{ storage_bucket: string; storage_key: string }>(
      `SELECT storage_bucket, storage_key FROM simforge.artifact_uploads WHERE id = :id`, { id: reservation.artifactId },
    );
    await writeLocalObject(stored!.storage_bucket, stored!.storage_key, upload.bytes, upload.mediaType);
    artifacts.push({ artifactId: reservation.artifactId, identity: upload.identity, sha256: sha, sizeBytes: upload.bytes.byteLength, mediaType: upload.mediaType });
  }
  return completeRenderJobV2({
    jobId: lease.jobId, leaseId: lease.lease.leaseId, fenceToken: lease.lease.fenceToken, workerNodeId: WORKER_NODE_ID,
    intentSha256: lease.intentSha256, manifest: { artifacts },
  });
}

async function jobRow(jobId: string) {
  return queryOne<{ job_state: string; failure_code: string | null; message: string | null; details: unknown; lease_state: string }>(
    `SELECT j.job_state, j.failure_code, j.failure_detail->>'message' AS message, j.failure_detail->'details' AS details,
            (SELECT l.lease_state FROM simforge.worker_leases l WHERE l.render_job_id = j.id ORDER BY l.leased_at DESC LIMIT 1) AS lease_state
       FROM simforge.render_jobs j WHERE j.id = :id`,
    { id: jobId },
  );
}

async function expectRefused(lease: Lease, manifest: unknown, code: string, message: RegExp) {
  await assert.rejects(complete(lease, manifest), (error: unknown) => {
    assert.ok(error instanceof RenderEvidenceRejectedError, String(error));
    assert.equal(error.message, code, "the completion route returns the bare code");
    assert.equal(error.verificationDetails.retryable, false);
    assert.equal(error.verificationDetails.jobFailed, true, "the control plane failed the job itself");
    assert.equal(error.verificationDetails.failureCode, `render.${code}`);
    assert.ok(JSON.stringify({ error: error.message, details: error.verificationDetails }).length < 2048, "the refusal fits the worker's 2 KiB error window");
    return true;
  });
  const row = await jobRow(lease.jobId);
  assert.equal(row?.job_state, "failed", "a degraded render is never retried or accepted");
  assert.equal(row?.failure_code, `render.${code}`);
  assert.match(row?.message ?? "", message);
  assert.equal(row?.lease_state, "released");
  // The worker's own failure report arrives after the lease is gone.
  assert.equal(await failRenderJobV2({
    jobId: lease.jobId, leaseId: lease.lease.leaseId, fenceToken: lease.lease.fenceToken, workerNodeId: WORKER_NODE_ID,
    intentSha256: lease.intentSha256, failure: { code: "render.execution_failed", message: "late", retryable: true },
  }), null);
  const detail = await getRenderJobDetail(CONTEXT, lease.jobId);
  assert.equal(detail?.failureCode, `render.${code}`);
  assert.match(detail?.failureDetail ?? "", message, "the job result names what is missing");
}

test("the control plane refuses degraded CARLA renders and records allowed substitutions", async (t) => {
  t.after(() => shutdownDatabase());
  await migrate();
  await seedScenarioLineage();
  await registration();

  assert.deepEqual([...leaseControlFeatures("v1")], [...CONTROL_FEATURES_V1]);
  assert.deepEqual([...leaseControlFeatures(null)], []);

  let lease = await leasedJob();
  await expectRefused(lease, carlaManifest(lease, { evidence: replayEvidence(lease, { trajectory: { droppedActorIds: ["ped_child"] } }) }), "carla_actors_dropped", /ped_child/);

  lease = await leasedJob();
  await expectRefused(lease, carlaManifest(lease, {
    evidence: replayEvidence(lease, { execution: { mode: "native-physics", purpose: "physics-validation" } }),
  }), "carla_run_not_scenario_render", /physics-validation/);

  lease = await leasedJob();
  await expectRefused(lease, carlaManifest(lease, {
    attestation: exactAttestation({}, { map: { identityMode: "generated-opendrive", binding: "exact", exact: true, loadedMapName: "OpenDriveMap" } }),
  }), "carla_map_generated", /bare OpenDRIVE/);

  lease = await leasedJob();
  await expectRefused(lease, carlaManifest(lease, {
    attestation: exactAttestation({}, { environment: { exact: false, mode: "cooked-baked-default", reason: "custom-map-baked-default-daylight" } }),
  }), "carla_environment_not_exact", /cooked-baked-default/);

  const substitution = { kind: "carla-actor-body", subject: "ped_child", requested: "walker.child", rendered: "walker.adult", allowedBy: "allowSubstitutions" };
  lease = await leasedJob();
  await expectRefused(lease, carlaManifest(lease, { substitutions: [substitution] }), "render_substitution_not_allowed", /ped_child carla-actor-body walker\.child -> walker\.adult/);

  // An rc.73 executor listed substituted bodies only in carlaVehicleFallbacks.
  const fallback = { actorId: "ped_child", authoredCatalogId: "walker.child", fallbackCatalogId: "walker.adult", vehicleClass: "pedestrian" };
  lease = await leasedJob();
  await expectRefused(lease, carlaManifest(lease, { carlaVehicleFallbacks: [fallback], substitutions: null }), "carla_actor_body_substituted", /ped_child: walker\.child -> walker\.adult/);

  lease = await leasedJob();
  const { purpose: _purpose, ...executionWithoutPurpose } = replayEvidence(lease).execution;
  await expectRefused(lease, carlaManifest(lease, {
    evidence: { ...replayEvidence(lease), execution: executionWithoutPurpose },
  }), "carla_parity_evidence_invalid", /execution\.purpose/);

  // An exact render whose one substitution the intent allowed and the manifest records.
  lease = await leasedJob({ allowSubstitutions: ["carla-actor-body"] });
  await appendRenderProgressV2({
    schema: "simforge.render-worker-control/v2", type: "lease.progress",
    jobId: lease.jobId, leaseId: lease.lease.leaseId, fenceToken: lease.lease.fenceToken, workerNodeId: WORKER_NODE_ID,
    records: [{
      schema: "simforge.render-progress/v1", event: "warning", code: "native_capture_clock_unsupported",
      message: "the render service does not pin the capture clock", jobId: lease.jobId, attempt: lease.attempt,
      sequence: 0, timestamp: new Date().toISOString(),
    }],
  } as Parameters<typeof appendRenderProgressV2>[0]);
  // A future evidence key from a newer worker is tolerated, not a failure.
  const evidence = { ...replayEvidence(lease), futureEvidenceField: { note: 1 } };
  assert.deepEqual(await complete(lease, carlaManifest(lease, { evidence, substitutions: [{ ...substitution, details: { reason: "this CARLA runtime cannot place walker.child" } }] })), {
    schema: "simforge.render-worker-control/v2", type: "mutation.accepted",
  });
  const row = await jobRow(lease.jobId);
  assert.equal(row?.job_state, "succeeded");
  const detail = await getRenderJobDetail(CONTEXT, lease.jobId);
  assert.deepEqual(detail?.substitutions, [substitution]);
  assert.deepEqual(detail?.warnings, [{ code: "native_capture_clock_unsupported", message: "the render service does not pin the capture clock" }]);
  assert.equal(detail?.failureDetail, null);
});

test("the job result shows only messages that name what is missing, and every lane's warnings", () => {
  assert.equal(publicFailureDetail("render.carla_actors_dropped", "CARLA dropped ped_child"), "CARLA dropped ped_child");
  assert.equal(publicFailureDetail("render.native_timeline_missing", "  no render.timeline  "), "no render.timeline");
  // Other worker messages (log tails, transport errors) stay redacted.
  assert.equal(publicFailureDetail("render.execution_failed", "stderr tail with /home/worker paths"), null);
  assert.equal(publicFailureDetail("lease_expired", "x"), null);
  assert.equal(publicFailureDetail("render.carla_actors_dropped", null), null);
  assert.equal(publicFailureDetail("render.carla_actors_dropped", "x".repeat(5_000))?.length, 2_000);
  // The local CPU lane records warnings as job events.
  assert.deepEqual(publicRenderWarnings([], [{ code: "native_capture_clock_unsupported", message: "update-count" }]), [
    { code: "native_capture_clock_unsupported", message: "update-count" },
  ]);
  assert.throws(() => publicRenderWarnings([], [{ code: "x" }]));
  assert.deepEqual(publicRenderSubstitutions(null), []);
  assert.deepEqual(publicRenderSubstitutions({ failureCode: "render.x" }), []);
  assert.throws(() => publicRenderSubstitutions({ renderSubstitutions: [{ kind: "x" }] }));
});
