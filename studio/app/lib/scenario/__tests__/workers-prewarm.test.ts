import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SIMFORGE_ENV = "dev";

import { LOCAL_HOST_TOKEN_ENV } from "@simforge-oss/studio-host/node";
import { CONTROL_FEATURES_V1, loadBuiltinRenderEngine } from "@simforge-oss/render";
import { PRONTO_CHASE_CAMERA_SENSOR, PRONTO_CHASE_CAMERA_SENSOR_ID } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "../../auth/session";
import { execute, queryOne, shutdownDatabase } from "../../db/data-api";
import { approveRenderWorker } from "../control-plane-store";
import { createRenderIntentJob } from "../render-intent-store";
import { claimResponseV2, registerRenderWorkerV2, signRenderInputsV2 } from "../render-worker-control-store";
import { ScenarioRendererCapabilitySchema } from "../render-wire-contracts";
import { canonicalJsonSha256, sha256 } from "../core";
import {
  activeNativeGpuCapacities,
  approvedRenderWorker,
  knownNativeSceneDemand,
  NativeSceneMemoryError,
  listPrewarmMembers,
  listPrewarmSets,
  recordWorkerCacheStatus,
  signPrewarmBlobs,
  workerPrewarmFeatures,
} from "../workers-prewarm-store";
import { CONTROL_FEATURE_PREWARM_DERIVATIVES, PrewarmManifestResponseSchema } from "@simforge-oss/render";
import { getRegisteredMap, invalidateRegisteredMap } from "../../cloud/map-registry";

process.env[LOCAL_HOST_TOKEN_ENV] = "test-local-host-token";

const WORKER_NODE_ID = "simforge-render-prewarm-3090";
const SOURCE_REVISION = "3".repeat(40);
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const REVISION_ID = "usrev_prewarm";
const EXECUTION_PACKAGE_ID = "usepkg_prewarm";
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
      key: `prewarm/${id}`,
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
       'usacv_prewarm', :workspace_id, 'uniscenario.asset-catalog/v1', 'usart_catalog', :sha256,
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
       'usmapv_prewarm', :workspace_id, 'map-yale', 'Yale St', 'local://manifest', 'local://topology',
       'usart_xodr', :xodr_sha256, 'epsg:32610', :coordinate_sha256, '{}'::jsonb, 'usacv_prewarm'
     ) ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID, xodr_sha256: DIGEST("b"), coordinate_sha256: DIGEST("c") },
  );
  await execute(
    `INSERT INTO simforge.datasets (id, workspace_id, name)
     VALUES ('usds_prewarm', :workspace_id, 'prewarm')
     ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
  await execute(
    `INSERT INTO simforge.documents (id, workspace_id, dataset_id, title, schema_version, map_version_id)
     VALUES ('usdoc_prewarm', :workspace_id, 'usds_prewarm', 'Yale St', 'simforge.scenario/v1', 'usmapv_prewarm')
     ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
  await execute(
    `INSERT INTO simforge.revisions (
       id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
       canonical_content, content_sha256, map_version_id, compiler_version
     ) VALUES (
       :revision_id, :workspace_id, 'usdoc_prewarm', 1, 1, 'simforge.scenario/v1',
       CAST(:content AS jsonb), :content_sha256, 'usmapv_prewarm', 'uniscenario-compiler@2.0.0'
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
       'usacv_prewarm', 'usart_package', :manifest_sha256, :xsd_sha256,
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


const RELEASE = DIGEST("d");

/** One published native set on the seeded map version: three members, one retired-map blob. */
async function seedNativeSet() {
  await execute(
    `UPDATE simforge.map_versions SET descriptor = jsonb_build_object('registryReleaseDigest', CAST(:release AS text)) WHERE id = 'usmapv_prewarm'`,
    { release: RELEASE },
  );
  await execute(
    `INSERT INTO simforge.native_map_asset_sets (
       id, workspace_id, map_version_id, closure_sha256, registry_release_digest, canonical_digest,
       object_count, byte_length, asset_set_state
     ) VALUES ('usnset_prewarm', :workspace_id, 'usmapv_prewarm', :closure, :release, :canonical, 3, 30, 'available')`,
    { workspace_id: LOCAL_WORKSPACE_ID, closure: DIGEST("8"), release: RELEASE, canonical: DIGEST("9") },
  );
  const members = [["master.gltf", DIGEST("a"), "manifest"], ["geometry.bin", DIGEST("f"), "geometry"], ["images/x.ktx2", DIGEST("0"), "texture"]] as const;
  for (const [index, [relativePath, sha256, role]] of members.entries()) {
    await execute(
      `INSERT INTO simforge.native_map_asset_blobs (id, storage_bucket, storage_key, sha256, byte_length, media_type, verification_state)
       VALUES (:id, 'local-artifacts', :key, :sha256, 10, 'application/octet-stream', 'verified')`,
      { id: `usnblob_${index}`, key: `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`, sha256 },
    );
    await execute(
      `INSERT INTO simforge.native_map_asset_members (asset_set_id, relative_path, blob_id, role)
       VALUES ('usnset_prewarm', :relative_path, :blob_id, :role)`,
      { relative_path: relativePath, blob_id: `usnblob_${index}`, role },
    );
  }
  await execute(`UPDATE simforge.map_versions SET native_map_asset_set_id = 'usnset_prewarm' WHERE id = 'usmapv_prewarm'`);
}

/**
 * Publish a derivative set (map-derivatives.ts) for the seeded map version and
 * bind it by descriptor, the way SimCloud's reconcile-map-derivatives does.
 */
async function bindDerivative(key: "geometryLod" | "texturesFullBc7", schema: string, setId: string, members: ReadonlyArray<readonly [string, string, number]>, manifestSha256: string, objectCount = members.length) {
  await execute(
    `INSERT INTO simforge.native_map_asset_sets (
       id, workspace_id, map_version_id, contract_version, closure_sha256, registry_release_digest, canonical_digest,
       object_count, byte_length, asset_set_state
     ) VALUES (:id, :workspace_id, 'usmapv_prewarm', 'simforge.map-derivative-set.v1', :closure, :release, :canonical, :count, :bytes, 'available')`,
    { id: setId, workspace_id: LOCAL_WORKSPACE_ID, closure: DIGEST("c"), release: sha256(`${key}:${setId}`), canonical: DIGEST("b"), count: objectCount, bytes: members.reduce((sum, member) => sum + member[2], 0) },
  );
  for (const [relativePath, digest, bytes] of members) {
    await execute(
      `INSERT INTO simforge.native_map_asset_blobs (id, storage_bucket, storage_key, sha256, byte_length, media_type, verification_state)
       VALUES (:id, 'local-artifacts', :key, :sha256, :bytes, 'application/octet-stream', 'verified') ON CONFLICT (id) DO NOTHING`,
      { id: `usnblob_${digest.slice(0, 24)}`, key: `blobs/sha256/${digest.slice(0, 2)}/${digest}`, sha256: digest, bytes },
    );
    await execute(
      `INSERT INTO simforge.native_map_asset_members (asset_set_id, relative_path, blob_id, role) VALUES (:set, :path, :blob, 'geometry')`,
      { set: setId, path: relativePath, blob: `usnblob_${digest.slice(0, 24)}` },
    );
  }
  await execute(
    `UPDATE simforge.map_versions SET descriptor = descriptor || jsonb_build_object(CAST(:key AS text), CAST(:binding AS jsonb)) WHERE id = 'usmapv_prewarm'`,
    { key, binding: JSON.stringify({ state: "ready", schema, buildKey: DIGEST("4"), manifestSha256, assetSetId: setId, objectCount }) },
  );
}

test("workers prewarm published native sets, sign only their blobs, and lease without per-input URLs", async (t) => {
  t.after(() => shutdownDatabase());
  await migrate();
  await seedScenarioLineage();
  await seedNativeSet();

  const manifest = await listPrewarmSets();
  assert.deepEqual(manifest.sets.map((set) => [set.setId, set.mapVersionId, set.objectCount]), [["usnset_prewarm", "usmapv_prewarm", 3]]);
  assert.equal((await listPrewarmSets()).generation, manifest.generation, "an unchanged catalog keeps its generation");

  // Paging walks every member exactly once.
  const first = await listPrewarmMembers("usnset_prewarm", null, 2);
  assert.equal(first.members.length, 2);
  assert.ok(first.next);
  const second = await listPrewarmMembers("usnset_prewarm", first.next, 2);
  assert.equal(second.next, null);
  assert.deepEqual([...first.members, ...second.members].map((member) => member.relativePath).sort(), ["geometry.bin", "images/x.ktx2", "master.gltf"]);

  // A bound ambient turn-verdict table (browser closure blob) rides along once, on the last page.
  const verdictsSha = DIGEST("7");
  await execute(
    `INSERT INTO simforge.browser_asset_blobs (id, storage_bucket, storage_key, sha256, byte_length, media_type, verification_state)
     VALUES ('usbblob_verdicts', 'local-artifacts', :key, :sha256, 20480, 'application/gzip', 'verified')`,
    { key: `blobs/sha256/77/${verdictsSha}`, sha256: verdictsSha },
  );
  await execute(
    `UPDATE simforge.map_versions SET descriptor = descriptor || jsonb_build_object('ambientTurnVerdicts', jsonb_build_object('engineSemVer', '0.9.0', 'closureDigest', CAST(:closure AS text), 'sha256', CAST(:sha AS text))) WHERE id = 'usmapv_prewarm'`,
    { closure: DIGEST("8"), sha: verdictsSha },
  );
  const bound = await listPrewarmSets();
  assert.equal(bound.sets[0]!.turnVerdictsSha256, verdictsSha);
  assert.notEqual(bound.generation, manifest.generation, "binding a verdict table changes the generation");
  const page1 = await listPrewarmMembers("usnset_prewarm", null, 2);
  const page2 = await listPrewarmMembers("usnset_prewarm", page1.next, 2);
  const all = [...page1.members, ...page2.members];
  assert.deepEqual(all.filter((member) => member.relativePath === "derived/ambient/turn-verdicts.json.gz"), [
    { relativePath: "derived/ambient/turn-verdicts.json.gz", sha256: verdictsSha, sizeBytes: 20480 },
  ]);
  assert.deepEqual(Object.keys((await signPrewarmBlobs("usnset_prewarm", [verdictsSha])).downloads), [verdictsSha]);

  // Geometry derivatives a backfill bound by descriptor ride along the same way
  // (map-derivatives.ts): listed once on the last page, signable, in the generation.
  const lodManifestSha = DIGEST("5"), lodBinSha = DIGEST("6");
  const lodMembers = [["derived/geometry-lod/manifest.json", lodManifestSha, 4096], ["derived/geometry-lod/lod.bin", lodBinSha, 65536]] as const;
  await bindDerivative("geometryLod", "simforge.map-geometry-lod.v1", "usnset_lod_prewarm", lodMembers, lodManifestSha);
  // The descriptor carries a summary only, never the member list.
  assert.equal(((await queryOne<{ n: number }>(`SELECT jsonb_array_length(COALESCE(descriptor->'geometryLod'->'members', '[]'::jsonb)) AS n FROM simforge.map_versions WHERE id = 'usmapv_prewarm'`))!).n, 0);
  // The derivative set is never the version's closure: closure queries ignore it.
  assert.deepEqual((await listPrewarmSets()).sets.map((set) => set.setId), ["usnset_prewarm"]);
  const withLod = await listPrewarmSets();
  assert.notEqual(withLod.generation, bound.generation, "binding geometry derivatives changes the generation");
  // The digest field is gated: an rc.73 worker's strict schema would reject it.
  assert.equal("derivativesSha256" in withLod.sets[0]!, false, "not sent to a worker that did not declare prewarm.derivatives");
  assert.doesNotThrow(() => PrewarmManifestResponseSchema.parse(withLod));
  const withFeature = await listPrewarmSets(new Set([CONTROL_FEATURE_PREWARM_DERIVATIVES]));
  assert.match(withFeature.sets[0]!.derivativesSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(withFeature.generation, withLod.generation);
  assert.doesNotThrow(() => PrewarmManifestResponseSchema.parse(withFeature));
  // Binding a second kind (the GPU texture tier) changes the digest.
  const bc7ManifestSha = DIGEST("8");
  await bindDerivative("texturesFullBc7", "simforge.map-texture-variant.v1", "usnset_bc7_prewarm", [["derived/textures-full-bc7/manifest.json", bc7ManifestSha, 1024]], bc7ManifestSha);
  const withBc7 = await listPrewarmSets(new Set([CONTROL_FEATURE_PREWARM_DERIVATIVES]));
  assert.notEqual(withBc7.sets[0]!.derivativesSha256, withFeature.sets[0]!.derivativesSha256);
  const bc7Pages = [await listPrewarmMembers("usnset_prewarm", null, 50)];
  assert.ok(bc7Pages[0]!.members.some((member) => member.relativePath === "derived/textures-full-bc7/manifest.json"));
  await execute(`UPDATE simforge.map_versions SET descriptor = descriptor - 'texturesFullBc7' WHERE id = 'usmapv_prewarm'`);
  // An incomplete derivative set (a broken backfill) is not served by prewarm.
  await execute(`UPDATE simforge.map_versions SET descriptor = jsonb_set(descriptor, '{geometryLod,objectCount}', '3') WHERE id = 'usmapv_prewarm'`);
  assert.equal((await listPrewarmMembers("usnset_prewarm", null, 50)).members.some((member) => member.relativePath.startsWith("derived/geometry-lod/")), false);
  await execute(`UPDATE simforge.map_versions SET descriptor = jsonb_set(descriptor, '{geometryLod,objectCount}', '2') WHERE id = 'usmapv_prewarm'`);

  const lodPage1 = await listPrewarmMembers("usnset_prewarm", null, 2);
  const lodPage2 = await listPrewarmMembers("usnset_prewarm", lodPage1.next, 2);
  assert.deepEqual([...lodPage1.members, ...lodPage2.members].filter((member) => member.relativePath.startsWith("derived/geometry-lod/")), [
    { relativePath: "derived/geometry-lod/lod.bin", sha256: lodBinSha, sizeBytes: 65536 },
    { relativePath: "derived/geometry-lod/manifest.json", sha256: lodManifestSha, sizeBytes: 4096 },
  ]);
  assert.deepEqual(Object.keys((await signPrewarmBlobs("usnset_prewarm", [lodBinSha, lodManifestSha])).downloads).sort(), [lodManifestSha, lodBinSha].sort());
  await execute(`UPDATE simforge.map_versions SET descriptor = descriptor - 'geometryLod' WHERE id = 'usmapv_prewarm'`);
  assert.deepEqual(Object.keys((await signPrewarmBlobs("usnset_prewarm", [lodBinSha])).downloads), [], "an unbound derivative is not signed");

  // A browser derivative (tiers + packs, map-derivatives.ts) extends the
  // registry's browser member map, so the map asset gateway serves it; the
  // closure's own members win, and an incomplete set serves nothing.
  const envelopeSha = DIGEST("a").replace(/^a/, "b"), packSha = DIGEST("c").replace(/^c/, "d");
  for (const [id, sha, bytes] of [["usblob_env", envelopeSha, 700], ["usblob_pack", packSha, 16_000_000]] as const) {
    await execute(
      `INSERT INTO simforge.browser_asset_blobs (id, storage_bucket, storage_key, sha256, byte_length, media_type, verification_state)
       VALUES (:id, 'local-artifacts', :key, :sha256, :bytes, 'application/octet-stream', 'verified')`,
      { id, key: `blobs/sha256/${sha.slice(0, 2)}/${sha}`, sha256: sha, bytes },
    );
  }
  await execute(
    `INSERT INTO simforge.browser_asset_sets (id, workspace_id, map_version_id, contract_version, closure_sha256, object_count, byte_length, asset_set_state)
     VALUES ('usbset_variants', :workspace_id, 'usmapv_prewarm', 'simforge.map-derivative-set.v1', :closure, 2, 16000700, 'available')`,
    { workspace_id: LOCAL_WORKSPACE_ID, closure: DIGEST("e") },
  );
  for (const [path, blob] of [["derived/browser-variants/manifest.json", "usblob_env"], ["3d/packs/objects/x.bin", "usblob_pack"]] as const) {
    await execute(`INSERT INTO simforge.browser_asset_members (asset_set_id, relative_path, blob_id, role) VALUES ('usbset_variants', :path, :blob, 'texture')`, { path, blob });
  }
  const browserBinding = (objectCount: number) => JSON.stringify({ state: "ready", schema: "simforge.map-browser-variants.v1", buildKey: DIGEST("4"), manifestSha256: envelopeSha, assetSetId: "usbset_variants", objectCount });
  await execute(`UPDATE simforge.map_versions SET descriptor = descriptor || jsonb_build_object('browserVariants', CAST(:binding AS jsonb)) WHERE id = 'usmapv_prewarm'`, { binding: browserBinding(2) });
  invalidateRegisteredMap("usmapv_prewarm");
  const registered = await getRegisteredMap("usmapv_prewarm");
  assert.equal(registered?.browser.get("derived/browser-variants/manifest.json")?.sha256, envelopeSha);
  assert.equal(registered?.browser.get("3d/packs/objects/x.bin")?.byteLength, 16_000_000);
  // Browser derivatives never reach the native lease or prewarm digest.
  assert.equal((await listPrewarmSets(new Set([CONTROL_FEATURE_PREWARM_DERIVATIVES]))).sets[0]!.derivativesSha256, undefined);
  await execute(`UPDATE simforge.map_versions SET descriptor = descriptor || jsonb_build_object('browserVariants', CAST(:binding AS jsonb)) WHERE id = 'usmapv_prewarm'`, { binding: browserBinding(3) });
  invalidateRegisteredMap("usmapv_prewarm");
  assert.equal((await getRegisteredMap("usmapv_prewarm"))?.browser.has("3d/packs/objects/x.bin"), false, "an incomplete browser derivative is not served");
  await execute(`UPDATE simforge.map_versions SET descriptor = descriptor - 'browserVariants' WHERE id = 'usmapv_prewarm'`);
  invalidateRegisteredMap("usmapv_prewarm");

  // Only digests of that published set are signed.
  const signed = await signPrewarmBlobs("usnset_prewarm", [DIGEST("a"), DIGEST("e"), "not-a-digest"]);
  assert.deepEqual(Object.keys(signed.downloads), [DIGEST("a")]);
  assert.deepEqual(Object.keys((await signPrewarmBlobs("usnset_other", [DIGEST("a")])).downloads), []);
  await execute(`UPDATE simforge.map_versions SET retired_at = NOW() WHERE id = 'usmapv_prewarm'`);
  assert.deepEqual(Object.keys((await signPrewarmBlobs("usnset_prewarm", [DIGEST("a")])).downloads), [], "a retired map version is no longer signed");
  assert.equal((await listPrewarmSets()).sets.length, 0);
  await execute(`UPDATE simforge.map_versions SET retired_at = NULL WHERE id = 'usmapv_prewarm'`);

  // A batch-v1 worker: approved, registered, leases a job with identities only.
  const engine = await loadBuiltinRenderEngine("carla", { engineVersion: SOURCE_REVISION });
  const capability = ScenarioRendererCapabilitySchema.parse(engine.capabilities);
  assert.equal(await approvedRenderWorker(WORKER_NODE_ID), false);
  await approveRenderWorker(WORKER_NODE_ID, { engine: capability, labels: { ...CARLA_LABELS }, reason: "prewarm test" });
  const registration = await registerRenderWorkerV2({
    workerId: WORKER_NODE_ID, instanceId: "prewarm-1", engine: capability,
    labels: { ...CARLA_LABELS, inputUrls: "batch-v1", controlFeatures: "v1" },
  });
  assert.equal(await approvedRenderWorker(WORKER_NODE_ID), true);
  assert.equal(await approvedRenderWorker(WORKER_NODE_ID, "uswr_someone_else"), false);

  const status = { state: "prewarming", maps: { ready: 1, total: 2 }, blobs: { cached: 3, wanted: 5 }, bytes: { cached: 30, wanted: 50, budget: 100 }, updatedAt: new Date().toISOString() };
  assert.ok(await recordWorkerCacheStatus(WORKER_NODE_ID, registration.registrationId, status));
  assert.equal(await recordWorkerCacheStatus(WORKER_NODE_ID, "uswr_stale", status), null);
  assert.deepEqual(await queryOne(
    `SELECT metadata->'cacheStatus'->'maps' AS maps, metadata->'labels'->>'inputUrls' AS input_urls FROM simforge.worker_nodes WHERE id = :id`,
    { id: WORKER_NODE_ID },
  ), { maps: { ready: 1, total: 2 }, input_urls: "batch-v1" });

  // Scene-memory demand measured by warm workers drives native admission.
  assert.ok(await recordWorkerCacheStatus(WORKER_NODE_ID, registration.registrationId, {
    ...status,
    gpu: { totalBytes: 24 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 },
    demand: [
      { mapVersionId: "usmapv_prewarm", renderTextures: "uastc-full", sceneBytes: 30 * 1024 ** 3, textureBytes: 29 * 1024 ** 3 },
      { mapVersionId: "usmapv_prewarm", renderTextures: "bc7-512", sceneBytes: 2 * 1024 ** 3, textureBytes: 1024 ** 3 },
    ],
  }));
  assert.equal(await knownNativeSceneDemand("usmapv_prewarm", "uastc-full"), null, "a CARLA worker's report is not native evidence");
  await execute(`UPDATE simforge.worker_nodes SET renderer_engine = 'native' WHERE id = :id`, { id: WORKER_NODE_ID });
  assert.equal(await knownNativeSceneDemand("usmapv_prewarm", "uastc-full"), 30 * 1024 ** 3);
  assert.equal(await knownNativeSceneDemand("usmapv_other", "uastc-full"), null);
  assert.deepEqual(await activeNativeGpuCapacities(), [24576 * 1024 * 1024]);
  const refusal = new NativeSceneMemoryError(31 * 1024 ** 3, 24 * 1024 ** 3, "uastc-full");
  assert.equal(refusal.message, "uniscenario_render_resource_mapTextureMemory_exceeded");
  assert.match(refusal.detail, /needs about 31.0 GB and the largest available render GPU has 24.0 GB. Render at ML quality/);
  // Submission refuses a native render the fleet measurably cannot hold, with advice.
  await assert.rejects(
    createRenderIntentJob(
      { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID },
      {
        schema: "simforge.submit-render-intent/v1", revisionId: REVISION_ID, executionPackageId: EXECUTION_PACKAGE_ID,
        engine: "native", renderSpec: RENDER_SPEC, idempotencyKey: "prewarm-native-too-big",
      } as Parameters<typeof createRenderIntentJob>[1],
    ),
    (error: unknown) => error instanceof NativeSceneMemoryError && /largest available render GPU has 24.0 GB/.test(error.detail),
  );
  // With geometry derivatives bound, a native intent declares them as map members.
  await execute(
    `UPDATE simforge.map_versions SET descriptor = descriptor || jsonb_build_object('geometryLod', CAST(:lod AS jsonb)) WHERE id = 'usmapv_prewarm'`,
    { lod: JSON.stringify({ state: "ready", schema: "simforge.map-geometry-lod.v1", buildKey: DIGEST("4"), manifestSha256: lodManifestSha, assetSetId: "usnset_lod_prewarm", objectCount: 2 }) },
  );
  assert.ok(await recordWorkerCacheStatus(WORKER_NODE_ID, registration.registrationId, {
    ...status,
    gpu: { totalBytes: 24 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 },
    demand: [{ mapVersionId: "usmapv_prewarm", renderTextures: "uastc-full", sceneBytes: 2 * 1024 ** 3, textureBytes: 1024 ** 3 }],
  }));
  const nativeJob = await createRenderIntentJob(
    { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID },
    {
      schema: "simforge.submit-render-intent/v1", revisionId: REVISION_ID, executionPackageId: EXECUTION_PACKAGE_ID,
      engine: "native", renderSpec: RENDER_SPEC, idempotencyKey: "prewarm-native-geometry-lod",
    } as Parameters<typeof createRenderIntentJob>[1],
  );
  assert.ok(nativeJob);
  const nativeIntent = await queryOne<{ intent: { assets: Array<{ assetId: string; sha256: string; sizeBytes: number }> } }>(
    `SELECT render_intent AS intent FROM simforge.render_jobs WHERE id = :id`, { id: nativeJob.id },
  );
  const declared = new Map(nativeIntent!.intent.assets.map((asset) => [asset.assetId, asset]));
  assert.equal(declared.get(`map.resource.${sha256("derived/geometry-lod/lod.bin")}`)?.sha256, lodBinSha);
  assert.equal(declared.get(`map.resource.${sha256("derived/geometry-lod/manifest.json")}`)?.sizeBytes, 4096);
  assert.equal(declared.get("map.tile.000000")?.sha256, DIGEST("a"), "the closure members are still declared");
  // A binding whose blob is gone is a broken backfill: refused, not half-declared.
  await execute(`UPDATE simforge.native_map_asset_blobs SET verification_state = 'pending' WHERE sha256 = :sha`, { sha: lodBinSha });
  await assert.rejects(createRenderIntentJob(
    { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID },
    {
      schema: "simforge.submit-render-intent/v1", revisionId: REVISION_ID, executionPackageId: EXECUTION_PACKAGE_ID,
      engine: "native", renderSpec: RENDER_SPEC, idempotencyKey: "prewarm-native-geometry-lod-broken",
    } as Parameters<typeof createRenderIntentJob>[1],
  ), /map_derivative_member_unavailable/);
  await execute(`UPDATE simforge.native_map_asset_blobs SET verification_state = 'verified' WHERE sha256 = :sha`, { sha: lodBinSha });
  // A native worker's lease carries the declared derivative members with their paths.
  const nativeEngine = await loadBuiltinRenderEngine("native", { engineVersion: SOURCE_REVISION, binary: "/nonexistent/native-render-service" });
  const nativeCapability = ScenarioRendererCapabilitySchema.parse(nativeEngine.capabilities);
  const NATIVE_LABELS = { imageDigest: IMAGE_DIGEST, hardwareProfile: "rtx3080-10gb-v1", gpuModel: "NVIDIA GeForce RTX 3080", gpuMemoryMiB: "10240" };
  await approveRenderWorker("simforge-render-prewarm-native", { engine: nativeCapability, labels: { ...NATIVE_LABELS }, reason: "geometry-lod lease test" });
  const nativeRegistration = await registerRenderWorkerV2({
    workerId: "simforge-render-prewarm-native", instanceId: "prewarm-native-1", engine: nativeCapability,
    labels: { ...NATIVE_LABELS, inputUrls: "batch-v1", controlFeatures: "v1", prewarmFeatures: `${CONTROL_FEATURE_PREWARM_DERIVATIVES},something-newer` },
  });
  // A worker declares at registration which newer prewarm fields it parses.
  assert.ok((await workerPrewarmFeatures("simforge-render-prewarm-native")).has(CONTROL_FEATURE_PREWARM_DERIVATIVES));
  assert.equal((await workerPrewarmFeatures(WORKER_NODE_ID)).has(CONTROL_FEATURE_PREWARM_DERIVATIVES), false);
  const nativeLease = await claimResponseV2(nativeRegistration.registrationId, "simforge-render-prewarm-native");
  if (nativeLease.type === "job.leased") {
    assert.equal(nativeLease.jobId, nativeJob.id);
    const leased = new Map((nativeLease.inputs as Array<{ inputId: string; relativePath?: string; sha256: string }>).map((input) => [input.inputId, input]));
    assert.equal(leased.get(`map.resource.${sha256("derived/geometry-lod/lod.bin")}`)?.relativePath, "derived/geometry-lod/lod.bin");
    assert.equal(leased.get(`map.resource.${sha256("derived/geometry-lod/manifest.json")}`)?.sha256, lodManifestSha);
    await execute(`UPDATE simforge.worker_leases SET lease_state = 'released' WHERE render_job_id = :id`, { id: nativeJob.id });
  } else {
    assert.fail(`the native worker should lease the geometry-lod job, got ${nativeLease.type}`);
  }
  await execute(`UPDATE simforge.render_jobs SET job_state = 'cancelled' WHERE id = :id`, { id: nativeJob.id });
  await execute(`UPDATE simforge.map_versions SET descriptor = descriptor - 'geometryLod' WHERE id = 'usmapv_prewarm'`);
  await execute(`UPDATE simforge.worker_nodes SET renderer_engine = 'carla' WHERE id = :id`, { id: WORKER_NODE_ID });

  const job = await createRenderIntentJob(
    { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID },
    {
      schema: "simforge.submit-render-intent/v1",
      revisionId: REVISION_ID,
      executionPackageId: EXECUTION_PACKAGE_ID,
      engine: "carla",
      renderSpec: RENDER_SPEC,
      idempotencyKey: "prewarm-lease-test",
    } as Parameters<typeof createRenderIntentJob>[1],
  );
  assert.ok(job);
  const lease = await claimResponseV2(registration.registrationId, WORKER_NODE_ID);
  assert.equal(lease.type, "job.leased");
  if (lease.type !== "job.leased") return;
  const inputs = lease.inputs as Array<{ inputId: string; download?: unknown }>;
  assert.ok(inputs.length >= 3);
  assert.ok(inputs.every((input) => input.download === undefined), "a batch-v1 lease carries no signed URL or bearer token");
  assert.ok(!JSON.stringify(lease).includes("authorization"));
  // A worker that declared controlFeatures=v1 learns which newer output fields this plane accepts.
  assert.deepEqual((lease as { controlFeatures?: string[] }).controlFeatures, [...CONTROL_FEATURES_V1]);

  const urls = await signRenderInputsV2({
    jobId: job.id, leaseId: lease.lease.leaseId, fenceToken: lease.lease.fenceToken, workerNodeId: WORKER_NODE_ID,
    inputIds: [...inputs.map((input) => input.inputId), "undeclared-object"],
  });
  assert.ok(urls);
  assert.deepEqual(Object.keys(urls.downloads).sort(), inputs.map((input) => input.inputId).sort());
  assert.equal(await signRenderInputsV2({
    jobId: job.id, leaseId: lease.lease.leaseId, fenceToken: "wrong-fence", workerNodeId: WORKER_NODE_ID, inputIds: ["scenario.xosc"],
  }), null);

  // The worker restarts mid-job: registering again releases its orphaned
  // lease and requeues the job at once, instead of after the 15 min lease.
  await registerRenderWorkerV2({
    workerId: WORKER_NODE_ID, instanceId: "prewarm-1", engine: capability,
    labels: { ...CARLA_LABELS, inputUrls: "batch-v1" },
  });
  assert.deepEqual(await queryOne(
    `SELECT j.job_state, l.lease_state, a.attempt_state
       FROM simforge.render_jobs j
       JOIN simforge.worker_leases l ON l.render_job_id = j.id
       JOIN simforge.render_attempts a ON a.id = l.render_attempt_id
      WHERE j.id = :id`,
    { id: job.id },
  ), { job_state: "queued", lease_state: "expired", attempt_state: "expired" });
  assert.equal(await signRenderInputsV2({
    jobId: job.id, leaseId: lease.lease.leaseId, fenceToken: lease.lease.fenceToken, workerNodeId: WORKER_NODE_ID, inputIds: ["scenario.xosc"],
  }), null, "the released lease no longer authorizes anything");
  const retry = await claimResponseV2(registration.registrationId, WORKER_NODE_ID);
  assert.equal(retry.type, "job.leased");
  assert.equal(retry.type === "job.leased" ? retry.attempt : 0, 2);
});
