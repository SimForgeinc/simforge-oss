import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SIMFORGE_ENV = "dev";

import { LOCAL_HOST_TOKEN_ENV } from "@simforge-oss/studio-host/node";
import { loadBuiltinRenderEngine } from "@simforge-oss/render";
import { NATIVE_ACTOR_ASSETS_INPUT_ID } from "@simforge-oss/render/native";
import { hashRenderIntent, PRONTO_CHASE_CAMERA_SENSOR, PRONTO_CHASE_CAMERA_SENSOR_ID } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import { execute, queryOne, queryRows, shutdownDatabase, type SqlParams } from "@/app/lib/db/data-api";
import { approveRenderWorker } from "../control-plane-store";
import { canonicalJsonSha256, sha256 } from "../core";
import {
  nativeMapMemberAsset,
  rehydrateRenderIntent,
  RENDER_INTENT_CLOSURE_REF_KEY,
  RENDER_INTENT_STORED_MAX_BYTES,
  RenderIntentTooLargeError,
  storedRenderIntent,
} from "../render-intent-closure";
import { createRenderIntentJob } from "../render-intent-store";
import { claimResponseV2, readRenderIntent, registerRenderWorkerV2, signRenderInputsV2 } from "../render-worker-control-store";
import { ScenarioRenderIntentSchema, ScenarioRendererCapabilitySchema, type ScenarioRenderIntent } from "../render-wire-contracts";

process.env[LOCAL_HOST_TOKEN_ENV] = "test-local-host-token";

const DIGEST = (fill: string): string => fill.repeat(64);

const FRONT_SENSOR = {
  id: "front",
  type: "dash_camera",
  label: "Front camera",
  mount: { position: { x: 1.6, y: 1.35, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
  camera: { horizontalFovDeg: 90, verticalFovDeg: 59, aspectRatio: 1.777778, nearM: 0.1, farM: 1_000 },
} as const;

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

type MemberRow = { set_id: string; object_count: number; relative_path: string; sha256: string; byte_length: number };

/**
 * A stand-in for the map registry that answers the two statements
 * `loadNativeClosureAssets` issues: closure members ordered by path, and the
 * members of the named derivative sets.
 */
function fakeRegistry(sets: Record<string, Array<{ path: string; sha256: string; bytes: number }>>) {
  const rows = (setId: string): MemberRow[] => (sets[setId] ?? []).map((member) => ({
    set_id: setId, object_count: sets[setId]!.length, relative_path: member.path, sha256: member.sha256, byte_length: member.bytes,
  }));
  return async <T>(sql: string, params: SqlParams = {}): Promise<T[]> => {
    if (params.set_id !== undefined) {
      return rows(String(params.set_id)).sort((a, b) => (a.relative_path < b.relative_path ? -1 : 1)) as T[];
    }
    return String(params.set_ids).split(",").flatMap(rows).reverse() as T[];
  };
}

function member(prefix: string, index: number) {
  const path = `${prefix}/${String(index).padStart(6, "0")}.bin`;
  return { path, sha256: sha256(`richmond:${path}`), bytes: 1_000 + index };
}

/**
 * A Richmond-shaped native intent: 5,000 closure members (with the release
 * record that is never declared), a geometry-LOD and a texture-tier
 * derivative set, the actor closure and the render timeline: 5,884 map
 * members, like Richmond Field Station on dev.
 */
function richmondFixture() {
  const closure = [
    { path: "master.gltf", sha256: sha256("richmond:master"), bytes: 4_096 },
    { path: ".map-release.json", sha256: sha256("richmond:release"), bytes: 512 },
    ...Array.from({ length: 4_999 }, (_, index) => member("tiles", index)),
  ];
  const lod = Array.from({ length: 60 }, (_, index) => member("derived/geometry-lod", index));
  const textures = Array.from({ length: 824 }, (_, index) => member("derived/textures-full-bc7", index));
  const sets = { usnset_richmond: closure, usnset_richmond_lod: lod, usnset_richmond_tex: textures };
  const declaredClosure = closure.filter((row) => row.path !== ".map-release.json")
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const derived = [...lod, ...textures].sort((a, b) => (a.path < b.path ? -1 : 1));
  const members = [...declaredClosure, ...derived].map((row) => nativeMapMemberAsset(row.path, row.sha256, row.bytes));
  const intent = ScenarioRenderIntentSchema.parse({
    schema: "simforge.render-intent/v1",
    intentId: "usri_richmond_fixture",
    executionPackage: { id: "usepkg_richmond", sourceInputDigest: DIGEST("5") },
    scenarioRevision: {
      revisionId: "usrev_richmond",
      scenarioSha256: DIGEST("6"),
      openScenario: { sha256: DIGEST("e"), sizeBytes: 4_096 },
      map: { mapId: "richmond-field-station", revisionId: "usmap_richmond", sha256: DIGEST("b") },
    },
    sensorHosts: RENDER_SPEC.sources.map((source) => ({ sourceId: source.outputName, actorId: "ego", vehicleAsset: { catalogAssetId: "vehicle.sedan" } }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    renderSpec: RENDER_SPEC,
    renderTextures: "uastc-full",
    nativeVramCapacityBytes: 10 * 1024 ** 3,
    assets: [
      { assetId: "usart_xodr", kind: "map", sha256: DIGEST("b"), sizeBytes: 4_096 },
      { assetId: "usart_catalog", kind: "catalog", sha256: DIGEST("1"), sizeBytes: 4_096 },
      ...members,
      { assetId: NATIVE_ACTOR_ASSETS_INPUT_ID, kind: "catalog", sha256: DIGEST("a"), sizeBytes: 123_456 },
      { assetId: "render.timeline", kind: "other", sha256: DIGEST("c"), sizeBytes: 65_536 },
    ],
    seed: 1_234_567,
  });
  const closureRef = { nativeMapAssetSetId: "usnset_richmond", derivativeSetIds: ["usnset_richmond_lod", "usnset_richmond_tex"], offset: 2, members };
  return { intent, sets, closureRef };
}

/**
 * The content hash of the Richmond-shaped intent above. Storing members by
 * reference changes only the row, never the intent a worker leases, so this
 * digest (the pre-change hash of the same document) must not move. If a
 * deliberate intent semantics change moves it, update it with that change.
 */
const RICHMOND_FIXTURE_INTENT_SHA256 = "03f663d2ccbfb585e14703a71ed4a40b294b386b3ae4aea7b95c230721d869a6";

test("a Richmond-shaped intent is stored without its members and read back byte-identical, digest unchanged", async () => {
  const { intent, sets, closureRef } = richmondFixture();
  assert.equal(intent.assets.length, 5_884 + 4);
  assert.equal(hashRenderIntent(intent), RICHMOND_FIXTURE_INTENT_SHA256);
  const stored = storedRenderIntent(intent, closureRef);
  const text = JSON.stringify(stored);
  assert.ok(Buffer.byteLength(text) < 16 * 1024, `stored intent is ${Buffer.byteLength(text)} bytes`);
  assert.ok(Buffer.byteLength(JSON.stringify(intent)) > 1_000_000, "the inline intent was over a megabyte");
  assert.deepEqual((stored.assets as Array<{ assetId: string }>).map((asset) => asset.assetId), ["usart_xodr", "usart_catalog", NATIVE_ACTOR_ASSETS_INPUT_ID, "render.timeline"]);
  const rehydrated = await rehydrateRenderIntent(fakeRegistry(sets), text);
  assert.deepEqual(rehydrated, intent);
  assert.equal(hashRenderIntent(rehydrated), RICHMOND_FIXTURE_INTENT_SHA256);
});

test("a closure that no longer reproduces the declared members fails with a named error", async () => {
  const { intent, sets, closureRef } = richmondFixture();
  const stored = storedRenderIntent(intent, closureRef);
  // One member's bytes differ from what the intent bound.
  const changed = { ...sets, usnset_richmond_lod: sets.usnset_richmond_lod.map((row, index) => (index === 3 ? { ...row, sha256: DIGEST("9") } : row)) };
  await assert.rejects(rehydrateRenderIntent(fakeRegistry(changed), stored), /^Error: render_intent_closure_mismatch:usnset_richmond$/);
  // A set whose members are gone (or unverified) is unavailable, never partially declared.
  const { usnset_richmond_tex: _gone, ...withoutTextures } = sets;
  await assert.rejects(rehydrateRenderIntent(fakeRegistry(withoutTextures), stored), /^Error: render_intent_closure_unavailable:usnset_richmond_tex$/);
  const short = { ...sets, usnset_richmond: sets.usnset_richmond.slice(1) };
  await assert.rejects(
    rehydrateRenderIntent(async <T>(sql: string, params: SqlParams = {}) => {
      const rows = await fakeRegistry(short)<MemberRow>(sql, params);
      return (params.set_id ? rows.map((row) => ({ ...row, object_count: row.object_count + 1 })) : rows) as T[];
    }, stored),
    /^Error: render_intent_closure_unavailable:usnset_richmond$/,
  );
  await assert.rejects(
    rehydrateRenderIntent(fakeRegistry(sets), { ...stored, [RENDER_INTENT_CLOSURE_REF_KEY]: { schema: "something/else" } }),
    /render_intent_closure_ref_invalid/,
  );
  // An intent without a reference (rows written before, non-native engines) is read as stored.
  assert.deepEqual(await rehydrateRenderIntent(fakeRegistry({}), JSON.stringify(intent)), intent);
});

test("a stored intent that would still be too large is refused at submission with a named error", () => {
  const { intent } = richmondFixture();
  // Without a closure reference (the pre-fix shape) the same document is refused, not sent to the database.
  const inline = { ...intent, assets: [...intent.assets, ...intent.assets.slice(2, 5_000).map((asset, index) => ({ ...asset, assetId: `extra.${index}` }))] } as ScenarioRenderIntent;
  assert.throws(() => storedRenderIntent(inline, null), (error: unknown) =>
    error instanceof RenderIntentTooLargeError
    && error.message === "render_intent_too_large"
    && error.storedBytes > RENDER_INTENT_STORED_MAX_BYTES
    && /limit is 1048576 bytes/.test(error.detail));
  // A closure offset that does not name the member run is a programming error, never stored.
  const { closureRef } = richmondFixture();
  assert.throws(() => storedRenderIntent(intent, { ...closureRef, offset: 3 }), /render_intent_closure_offset_invalid/);
});

// ---------------------------------------------------------------------------
// End to end against the local database: a 50,000-member map.

const REVISION_ID = "usrev_hugemap";
const EXECUTION_PACKAGE_ID = "usepkg_hugemap";
const MAP_VERSION_ID = "usmapv_hugemap";
const NATIVE_SET_ID = "usnset_hugemap";
const LOD_SET_ID = "usnset_hugemap_lod";
const HUGE_MEMBERS = 50_000;
const RELEASE = DIGEST("d");
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const NATIVE_WORKER = "simforge-render-hugemap-native";
const NATIVE_LABELS = { imageDigest: IMAGE_DIGEST, hardwareProfile: "rtx3080-10gb-v1", gpuModel: "NVIDIA GeForce RTX 3080", gpuMemoryMiB: "10240" };
const CANONICAL_CONTENT = {
  choreography: { clipSeconds: 20 },
  roles: [{ id: "ego", actor: { catalogId: "vehicle.sedan", sensors: [FRONT_SENSOR] } }],
};

async function artifact(id: string, kind: string, mediaType: string, digest: string, revisionId: string | null = REVISION_ID) {
  const provenance = revisionId
    ? { contract: "uniscenario.artifact-provenance/v1", producerRevisionId: revisionId }
    : { contract: "uniscenario.artifact-provenance/v1", producerJobFamily: "openscenario_compile", producerJobId: `seed-catalog:${id}` };
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
      id, workspace_id: LOCAL_WORKSPACE_ID, revision_id: revisionId, kind, media_type: mediaType,
      key: `hugemap/${id}`, sha256: digest,
      producer_family: revisionId ? null : "openscenario_compile",
      producer_job_id: revisionId ? null : `seed-catalog:${id}`,
      provenance,
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
       'usacv_hugemap', :workspace_id, 'uniscenario.asset-catalog/v1', 'usart_catalog', :sha256,
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
       :id, :workspace_id, 'map-huge', 'Huge map', 'local://manifest', 'local://topology',
       'usart_xodr', :xodr_sha256, 'epsg:32610', :coordinate_sha256,
       jsonb_build_object('registryReleaseDigest', CAST(:release AS text)), 'usacv_hugemap'
     ) ON CONFLICT (id) DO NOTHING`,
    { id: MAP_VERSION_ID, workspace_id: LOCAL_WORKSPACE_ID, xodr_sha256: DIGEST("b"), coordinate_sha256: DIGEST("c"), release: RELEASE },
  );
  await execute(
    `INSERT INTO simforge.datasets (id, workspace_id, name) VALUES ('usds_hugemap', :workspace_id, 'huge map') ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID },
  );
  await execute(
    `INSERT INTO simforge.documents (id, workspace_id, dataset_id, title, schema_version, map_version_id)
     VALUES ('usdoc_hugemap', :workspace_id, 'usds_hugemap', 'Huge map', 'simforge.scenario/v1', :map_version_id) ON CONFLICT (id) DO NOTHING`,
    { workspace_id: LOCAL_WORKSPACE_ID, map_version_id: MAP_VERSION_ID },
  );
  await execute(
    `INSERT INTO simforge.revisions (
       id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
       canonical_content, content_sha256, map_version_id, compiler_version
     ) VALUES (
       :revision_id, :workspace_id, 'usdoc_hugemap', 1, 1, 'simforge.scenario/v1',
       CAST(:content AS jsonb), :content_sha256, :map_version_id, 'uniscenario-compiler@2.0.0'
     ) ON CONFLICT (id) DO NOTHING`,
    { revision_id: REVISION_ID, workspace_id: LOCAL_WORKSPACE_ID, content: CANONICAL_CONTENT, content_sha256: canonicalJsonSha256(CANONICAL_CONTENT), map_version_id: MAP_VERSION_ID },
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
       'usacv_hugemap', 'usart_package', :manifest_sha256, :xsd_sha256,
       'simforge.execution-package/v1', 'uniscenario-compiler@2.0.0', 'xml-1.4-trajectory-replay',
       :source_input_digest, 'disabled', :ambient_sha256,
       'usart_traffic', :ambient_sha256, :source_input_digest
     ) ON CONFLICT (id) DO NOTHING`,
    {
      package_id: EXECUTION_PACKAGE_ID, workspace_id: LOCAL_WORKSPACE_ID, revision_id: REVISION_ID,
      manifest_sha256: DIGEST("2"), xsd_sha256: DIGEST("4"), source_input_digest: DIGEST("5"), ambient_sha256: DIGEST("6"),
    },
  );
}

/**
 * A published native closure of 50,000 tiles plus `master.gltf` and the
 * release record, and a bound geometry-LOD derivative set of 40 members.
 */
async function seedHugeNativeMap() {
  await execute(
    `INSERT INTO simforge.native_map_asset_sets (
       id, workspace_id, map_version_id, closure_sha256, registry_release_digest, canonical_digest,
       object_count, byte_length, asset_set_state
     ) VALUES (:id, :workspace_id, :map_version_id, :closure, :release, :canonical, :count, 0, 'available')`,
    { id: NATIVE_SET_ID, workspace_id: LOCAL_WORKSPACE_ID, map_version_id: MAP_VERSION_ID, closure: DIGEST("8"), release: RELEASE, canonical: DIGEST("9"), count: HUGE_MEMBERS + 2 },
  );
  await execute(
    `INSERT INTO simforge.native_map_asset_blobs (id, storage_bucket, storage_key, sha256, byte_length, media_type, verification_state)
     SELECT 'usnblob_huge_' || g, 'local-artifacts', 'blobs/huge/' || g,
            encode(sha256(convert_to('huge-member-' || g, 'UTF8')), 'hex'), 100 + g, 'application/octet-stream', 'verified'
       FROM generate_series(0, :count) g`,
    { count: HUGE_MEMBERS + 1 },
  );
  await execute(
    `INSERT INTO simforge.native_map_asset_members (asset_set_id, relative_path, blob_id, role)
     SELECT :set_id,
            CASE g WHEN 0 THEN 'master.gltf' WHEN 1 THEN '.map-release.json' ELSE 'tiles/' || lpad(g::text, 6, '0') || '.glb' END,
            'usnblob_huge_' || g,
            CASE g WHEN 0 THEN 'manifest' ELSE 'geometry' END
       FROM generate_series(0, :count) g`,
    { set_id: NATIVE_SET_ID, count: HUGE_MEMBERS + 1 },
  );
  await execute(`UPDATE simforge.map_versions SET native_map_asset_set_id = :set_id WHERE id = :id`, { set_id: NATIVE_SET_ID, id: MAP_VERSION_ID });
  const lodCount = 40;
  await execute(
    `INSERT INTO simforge.native_map_asset_sets (
       id, workspace_id, map_version_id, contract_version, closure_sha256, registry_release_digest, canonical_digest,
       object_count, byte_length, asset_set_state
     ) VALUES (:id, :workspace_id, :map_version_id, 'simforge.map-derivative-set.v1', :closure, :release, :canonical, :count, 0, 'available')`,
    { id: LOD_SET_ID, workspace_id: LOCAL_WORKSPACE_ID, map_version_id: MAP_VERSION_ID, closure: DIGEST("c"), release: sha256(`geometryLod:${LOD_SET_ID}`), canonical: DIGEST("b"), count: lodCount },
  );
  await execute(
    `INSERT INTO simforge.native_map_asset_blobs (id, storage_bucket, storage_key, sha256, byte_length, media_type, verification_state)
     SELECT 'usnblob_hugelod_' || g, 'local-artifacts', 'blobs/hugelod/' || g,
            encode(sha256(convert_to('huge-lod-' || g, 'UTF8')), 'hex'), 10 + g, 'application/octet-stream', 'verified'
       FROM generate_series(1, :count) g`,
    { count: lodCount },
  );
  await execute(
    `INSERT INTO simforge.native_map_asset_members (asset_set_id, relative_path, blob_id, role)
     SELECT :set_id, CASE g WHEN 1 THEN 'derived/geometry-lod/manifest.json' ELSE 'derived/geometry-lod/lod-' || lpad(g::text, 3, '0') || '.bin' END,
            'usnblob_hugelod_' || g, 'geometry'
       FROM generate_series(1, :count) g`,
    { set_id: LOD_SET_ID, count: lodCount },
  );
  const manifest = await queryOne<{ sha256: string }>(`SELECT sha256 FROM simforge.native_map_asset_blobs WHERE id = 'usnblob_hugelod_1'`);
  await execute(
    `UPDATE simforge.map_versions SET descriptor = descriptor || jsonb_build_object('geometryLod', CAST(:binding AS jsonb)) WHERE id = :id`,
    {
      id: MAP_VERSION_ID,
      binding: JSON.stringify({ state: "ready", schema: "simforge.map-geometry-lod.v1", buildKey: DIGEST("4"), manifestSha256: manifest!.sha256, assetSetId: LOD_SET_ID, objectCount: lodCount }),
    },
  );
  return HUGE_MEMBERS + 1 + lodCount;
}

test("a native render of a 50,000-member map submits a small row and leases the full intent to a worker", async (t) => {
  t.after(() => shutdownDatabase());
  await migrate();
  await seedScenarioLineage();
  const declaredMembers = await seedHugeNativeMap();

  const job = await createRenderIntentJob(
    { workspaceId: LOCAL_WORKSPACE_ID, userId: LOCAL_USER_ID },
    {
      schema: "simforge.submit-render-intent/v1", revisionId: REVISION_ID, executionPackageId: EXECUTION_PACKAGE_ID,
      engine: "native", motionSource: "original-xosc", renderSpec: RENDER_SPEC, idempotencyKey: "hugemap-native",
    } as Parameters<typeof createRenderIntentJob>[1],
  );
  assert.ok(job, "the native intent enqueues");

  // The row: a few kilobytes, members by reference, digest over the full intent.
  const row = await queryOne<{ bytes: number | string; intent_sha256: string; ref: { nativeMapAssetSetId: string; derivativeSetIds: string[]; count: number; offset: number } }>(
    `SELECT octet_length(render_intent::text) AS bytes, intent_sha256, render_intent->'${RENDER_INTENT_CLOSURE_REF_KEY}' AS ref
       FROM simforge.render_jobs WHERE id = :id`,
    { id: job.id },
  );
  assert.ok(Number(row!.bytes) < 16 * 1024, `the stored intent is ${row!.bytes} bytes`);
  assert.deepEqual(
    { set: row!.ref.nativeMapAssetSetId, derivatives: row!.ref.derivativeSetIds, count: row!.ref.count, offset: row!.ref.offset },
    { set: NATIVE_SET_ID, derivatives: [LOD_SET_ID], count: declaredMembers, offset: 2 },
  );
  const intent = await readRenderIntent(queryRows, job.id);
  assert.ok(intent);
  assert.equal(intent.assets.length, declaredMembers + 3, "every member plus the XODR, the catalog and the actor closure");
  assert.equal(hashRenderIntent(intent), row!.intent_sha256);
  assert.ok(Buffer.byteLength(JSON.stringify(intent)) > 4 * 1024 * 1024, "the full intent is over the Data API's 4 MiB request cap");

  // A native worker leases it: the intent it verifies is the full one, and the
  // claimed inputs are exactly the declared assets plus the scenario.
  const engine = await loadBuiltinRenderEngine("native", { engineVersion: "3".repeat(40), binary: "/nonexistent/native-render-service" });
  const capability = ScenarioRendererCapabilitySchema.parse(engine.capabilities);
  await approveRenderWorker(NATIVE_WORKER, { engine: capability, labels: { ...NATIVE_LABELS }, reason: "huge map lease test" });
  const registration = await registerRenderWorkerV2({
    workerId: NATIVE_WORKER, instanceId: "hugemap-1", engine: capability,
    labels: { ...NATIVE_LABELS, inputUrls: "batch-v1", controlFeatures: "v1" },
  });

  // A member whose blob is no longer verified makes the job unleasable, by name: it stays queued.
  await execute(`UPDATE simforge.native_map_asset_blobs SET verification_state = 'pending' WHERE id = 'usnblob_huge_777'`);
  await assert.rejects(readRenderIntent(queryRows, job.id), /render_intent_closure_unavailable:usnset_hugemap/);
  assert.equal((await claimResponseV2(registration.registrationId, NATIVE_WORKER)).type, "job.none");
  assert.equal((await queryOne<{ job_state: string }>(`SELECT job_state FROM simforge.render_jobs WHERE id = :id`, { id: job.id }))?.job_state, "queued");
  await execute(`UPDATE simforge.native_map_asset_blobs SET verification_state = 'verified' WHERE id = 'usnblob_huge_777'`);

  const lease = await claimResponseV2(registration.registrationId, NATIVE_WORKER);
  assert.equal(lease.type, "job.leased");
  if (lease.type !== "job.leased") return;
  assert.equal(lease.jobId, job.id);
  assert.equal(lease.intentSha256, row!.intent_sha256);
  assert.equal(hashRenderIntent(lease.intent), lease.intentSha256, "the worker's own digest check passes");
  assert.deepEqual(lease.intent, intent);
  const inputs = lease.inputs as Array<{ inputId: string; sha256: string; sizeBytes: number }>;
  assert.deepEqual(
    inputs.map((input) => input.inputId).sort(),
    ["scenario.xosc", ...lease.intent.assets.map((asset) => asset.assetId)].sort(),
  );
  const declared = new Map(lease.intent.assets.map((asset) => [asset.assetId, asset]));
  assert.ok(inputs.every((input) => input.inputId === "scenario.xosc"
    || (declared.get(input.inputId)?.sha256 === input.sha256 && declared.get(input.inputId)?.sizeBytes === input.sizeBytes)));

  // Lease-scoped reads (input signing) resolve the same intent.
  const tile = `map.resource.${sha256("tiles/049999.glb")}`;
  const lod = `map.resource.${sha256("derived/geometry-lod/lod-040.bin")}`;
  const signed = await signRenderInputsV2({
    jobId: job.id, leaseId: lease.lease.leaseId, fenceToken: lease.lease.fenceToken, workerNodeId: NATIVE_WORKER,
    inputIds: ["map.tile.000000", tile, lod, "undeclared-object"],
  });
  assert.deepEqual(Object.keys(signed?.downloads ?? {}).sort(), ["map.tile.000000", tile, lod].sort());
});
