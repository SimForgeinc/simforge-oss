import "../../models/__tests__/test-env";
// Local presigned URLs are signed with the supervised host's control token.
process.env.SIMFORGE_LOCAL_HOST_TOKEN ??= "sim-result-store-test-token";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  gzipTrace,
  materializeTraceTraffic,
  simKey as computeSimKey,
  simulationCompletion,
  TRACE_SCHEMA,
  type AuthoritativeSimulation,
} from "@simforge-oss/compiler/node";
import { contentHash } from "@simforge-oss/engine";
import { runSimulation, traceDigest } from "@simforge-oss/engine/node";

import { migrate } from "../../../../scripts/migrate";
import { execute, queryOne, queryRows, shutdownDatabase } from "../../db/data-api";
import { putS3Object } from "../../s3/s3-put-object";
import {
  LANE_LEFT,
  scenario,
  syntheticGraph,
  vehicle,
} from "../../../../../packages/engine/src/__tests__/fixtures/scenarios";
import {
  claimSimulationJob,
  completeSimulationRequest,
  getSimulationResult,
  recordSimulationVerification,
  reserveSimulationJobOutputs,
  resolveRevisionSimulation,
  resolveSimulation,
  setSimulationExecutorForTests,
  simulationObjectKeys,
  type SimulationSubject,
} from "../sim-result-store";

/**
 * The authoritative simulation store: one execution per content, joined when
 * in flight, deduplicated by `sim_key`, never overwritten, executable inline
 * or by a CPU runner through the same fenced request row.
 */

const WORKSPACE = "ws_sim_results";
const USER = "user_sim_results";
const MAP_VERSION = "usmapv_sim";
const DIGEST = (c: string) => c.repeat(64);
const graph = syntheticGraph();

function fakeSimulation(seed: string, overrides: { simKeySeed?: string; speed?: number } = {}): AuthoritativeSimulation {
  const input = scenario({
    seed,
    actors: [vehicle(graph, { id: "ego", rsl: LANE_LEFT, s: 60, speedMps: overrides.speed ?? 10, cruiseSpeedMps: overrides.speed ?? 10 })],
  });
  const result = runSimulation(input, { graph });
  const resolvedInputDigest = contentHash(result.input);
  const traceSha256 = traceDigest(result.trace);
  const traceGzip = gzipTrace(result.trace);
  const traffic = materializeTraceTraffic({
    provider: "off",
    profile: {} as never,
    sourceInputDigest: resolvedInputDigest,
    map: { assetId: "map-sim", versionId: MAP_VERSION },
    trace: result.trace,
    ambientActorIds: [],
  });
  const key = computeSimKey({
    resolvedInputDigest: overrides.simKeySeed ? contentHash({ forced: overrides.simKeySeed }) : resolvedInputDigest,
    mapClosureDigest: DIGEST("e"),
    engineSemVer: "0.8.0",
    solverVer: "0.8.0",
    traceSchema: TRACE_SCHEMA,
  });
  return {
    simKey: key,
    traceSha256,
    authoredTraceSha256: traceSha256,
    trafficStepKey: null,
    resolvedInputDigest,
    mapClosureDigest: DIGEST("e"),
    engineSemVer: "0.8.0",
    solverVer: "0.8.0",
    traceSchema: TRACE_SCHEMA,
    engineBuild: { engineVersion: "test" },
    provider: "off",
    resolved: {
      template: {} as never,
      axisUntilClamps: [],
      concrete: { input: result.input, siteId: "site", materialization: {}, ambientTraffic: { actors: [] } as never },
      resolvedInput: result.input,
      executedInput: result.input,
    },
    trace: result.trace,
    traceGzip,
    traceGzipSha256: createHash("sha256").update(traceGzip).digest("hex"),
    traffic,
    simulateMs: 1,
  };
}

function subject(content: Record<string, unknown>): SimulationSubject {
  return {
    workspaceId: WORKSPACE,
    userId: USER,
    canonicalContent: content,
    contentSha256: contentHash(content),
    mapVersionId: MAP_VERSION,
  };
}

async function seed() {
  await execute(
    `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
     VALUES (:id, 'Sim Owner', 'sim@local.simforge', TRUE, 'owner') ON CONFLICT (id) DO NOTHING`,
    { id: USER },
  );
  await execute(`INSERT INTO public.ba_organization (id, name, slug) VALUES ('org_sim', 'Sim', 'sim') ON CONFLICT (id) DO NOTHING`);
  await execute(
    `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
     VALUES (:id, 'personal', 'sim', 'Sim', :user, 'org_sim') ON CONFLICT (id) DO NOTHING`,
    { id: WORKSPACE, user: USER },
  );
  for (const [id, kind, digest] of [["usart_sim_catalog", "asset_catalog_manifest", DIGEST("1")], ["usart_sim_xodr", "opendrive_xml", DIGEST("b")]] as const) {
    await execute(
      `INSERT INTO simforge.artifacts (id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key, sha256,
         byte_length, artifact_state, producer_job_family, producer_job_id, provenance)
       VALUES (:id, :ws, :kind, 'application/octet-stream', 'local-artifacts', :id, :sha, 10, 'available',
         'openscenario_compile', :job, CAST(:provenance AS jsonb)) ON CONFLICT (id) DO NOTHING`,
      { id, ws: WORKSPACE, kind, sha: digest, job: `seed:${id}`, provenance: { contract: "uniscenario.artifact-provenance/v1", producerJobFamily: "openscenario_compile", producerJobId: `seed:${id}` } },
    );
  }
  await execute(
    `INSERT INTO simforge.asset_catalog_versions (id, workspace_id, contract_version, manifest_artifact_id, manifest_sha256,
       source_inventory_sha256, pipeline_version, toolchain, provenance)
     VALUES ('usacv_sim', :ws, 'uniscenario.asset-catalog/v1', 'usart_sim_catalog', :sha, :inv, 'asset-catalog@1.0.0', '{}'::jsonb, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    { ws: WORKSPACE, sha: DIGEST("1"), inv: DIGEST("7") },
  );
  await execute(`INSERT INTO public.map_assets (id, name) VALUES ('map-sim', 'Sim map') ON CONFLICT (id) DO NOTHING`);
  await execute(
    `INSERT INTO simforge.map_versions (id, workspace_id, source_map_id, source_map_asset_id, label, browser_manifest_url,
       topology_artifact_url, xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256, descriptor,
       asset_catalog_version_id)
     VALUES (:id, :ws, 'map-sim', 'map-sim', 'Sim map', 'local://manifest', 'local://topology', 'usart_sim_xodr', :xodr,
       'epsg:32610', :coord, '{}'::jsonb, 'usacv_sim') ON CONFLICT (id) DO NOTHING`,
    { id: MAP_VERSION, ws: WORKSPACE, xodr: DIGEST("b"), coord: DIGEST("c") },
  );
  await execute(
    `INSERT INTO simforge.browser_asset_sets (id, workspace_id, map_version_id, closure_sha256, object_count, byte_length, asset_set_state)
     VALUES ('usbas_sim', :ws, :map, :closure, 1, 1, 'available') ON CONFLICT (id) DO NOTHING`,
    { ws: WORKSPACE, map: MAP_VERSION, closure: DIGEST("d") },
  );
  await execute(`UPDATE simforge.map_versions SET browser_asset_set_id = 'usbas_sim' WHERE id = :id`, { id: MAP_VERSION });
}

test("authoritative simulation results", async (t) => {
  t.after(async () => {
    setSimulationExecutorForTests(null);
    await shutdownDatabase();
  });
  await migrate();
  await seed();

  await t.test("executes once inline, then answers every request for the same content from the memo", async () => {
    let executions = 0;
    const simulation = fakeSimulation("memo");
    setSimulationExecutorForTests(async () => { executions += 1; return simulation; });
    const content = { roles: [], meta: { name: "memo" } };
    const first = await resolveSimulation(subject(content));
    assert.equal(first.state, "succeeded");
    assert.equal(first.state === "succeeded" && first.result.traceSha256, simulation.traceSha256);
    assert.equal(first.state === "succeeded" && first.result.simKey, simulation.simKey);
    const second = await resolveSimulation(subject(content));
    assert.equal(second.state, "succeeded");
    assert.equal(executions, 1);
    const stored = await getSimulationResult(WORKSPACE, simulation.simKey);
    assert.equal(stored?.trace.gzipSha256, simulation.traceGzipSha256);
    assert.match(stored?.trace.downloadUrl ?? "", /sim\/sha256\//);
  });

  await t.test("two contents resolving to one input share one immutable result", async () => {
    const simulation = fakeSimulation("shared");
    setSimulationExecutorForTests(async () => simulation);
    await resolveSimulation(subject({ roles: [], meta: { name: "shared-a" } }));
    await resolveSimulation(subject({ roles: [], meta: { name: "shared-b" } }));
    const rows = await queryRows<{ sim_key: string }>(
      `SELECT sim_key FROM simforge.sim_results WHERE workspace_id = :ws AND sim_key = :key`,
      { ws: WORKSPACE, key: simulation.simKey },
    );
    assert.equal(rows.length, 1);
    const requests = await queryRows<{ sim_key: string }>(
      `SELECT sim_key FROM simforge.sim_requests WHERE workspace_id = :ws AND sim_key = :key`,
      { ws: WORKSPACE, key: simulation.simKey },
    );
    assert.equal(requests.length, 2);
  });

  await t.test("a different trace under an existing key is recorded as a determinism violation and never replaces it", async () => {
    const original = fakeSimulation("violation-a", { simKeySeed: "same-key" });
    const divergent = fakeSimulation("violation-b", { simKeySeed: "same-key", speed: 13 });
    assert.equal(original.simKey, divergent.simKey);
    assert.notEqual(original.traceSha256, divergent.traceSha256);
    setSimulationExecutorForTests(async () => original);
    await resolveSimulation(subject({ roles: [], meta: { name: "violation-a" } }));
    setSimulationExecutorForTests(async () => divergent);
    await resolveSimulation(subject({ roles: [], meta: { name: "violation-b" } }));
    const stored = await getSimulationResult(WORKSPACE, original.simKey);
    assert.equal(stored?.traceSha256, original.traceSha256);
    const events = await queryRows<{ outcome: string; local_trace_sha256: string }>(
      `SELECT outcome, local_trace_sha256 FROM simforge.sim_verification_events WHERE sim_key = :key`,
      { key: original.simKey },
    );
    assert.deepEqual(events, [{ outcome: "mismatch", local_trace_sha256: divergent.traceSha256 }]);
  });

  await t.test("a request another executor holds is joined, not re-executed, and an expired lease is taken over", async () => {
    let executions = 0;
    const simulation = fakeSimulation("join");
    setSimulationExecutorForTests(async () => { executions += 1; return simulation; });
    const content = { roles: [], meta: { name: "join" } };
    // A CPU runner holds the request: the inline path must not run it again.
    process.env.SIMFORGE_SIMULATION_INLINE = "0";
    const queued = await resolveSimulation(subject(content));
    assert.equal(queued.state, "queued");
    const claim = await claimSimulationJob({ workerId: "runner-1", leaseSeconds: 300 });
    assert.ok(claim);
    assert.equal(claim.requestKey, queued.requestKey);
    process.env.SIMFORGE_SIMULATION_INLINE = "1";
    const joined = await resolveSimulation(subject(content), { waitMs: 400 });
    assert.equal(joined.state, "running");
    assert.equal(executions, 0);
    // The runner died: once its lease expires the next caller takes it over.
    await execute(`UPDATE simforge.sim_requests SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE request_key = :key`, { key: claim.requestKey });
    const taken = await resolveSimulation(subject(content));
    assert.equal(taken.state, "succeeded");
    assert.equal(executions, 1);
    // The dead runner's late completion is fenced out.
    const { completion } = simulationCompletion(simulation);
    await assert.rejects(
      completeSimulationRequest({ workspaceId: WORKSPACE, userId: null, requestKey: claim.requestKey, fenceToken: claim.fenceToken, producer: "cpu:runner-1", completion, verifyObjects: false }),
      /no longer held/,
    );
  });

  await t.test("a CPU runner completes a queued request through reserve, upload and complete", async () => {
    process.env.SIMFORGE_SIMULATION_INLINE = "0";
    try {
      const simulation = fakeSimulation("runner");
      const content = { roles: [], meta: { name: "runner" } };
      const queued = await resolveSimulation(subject(content));
      assert.equal(queued.state, "queued");
      const claim = await claimSimulationJob({ workerId: "runner-2", leaseSeconds: 300 });
      assert.ok(claim);
      assert.deepEqual(claim.canonicalContent, content);
      assert.equal(claim.map.browserClosureSha256, DIGEST("d"));
      const { completion, bytes } = simulationCompletion(simulation);
      const reserved = await reserveSimulationJobOutputs({ workspaceId: WORKSPACE, requestKey: claim.requestKey, fenceToken: claim.fenceToken, completion });
      assert.ok(reserved?.trace.uploadRequired);
      // Stand-in for the runner's presigned PUTs.
      const keys = simulationObjectKeys(WORKSPACE, completion);
      await putS3Object("local-artifacts", keys.trace, bytes.trace);
      await putS3Object("local-artifacts", keys.resolution, bytes.resolution);
      if (keys.traffic && bytes.traffic) await putS3Object("local-artifacts", keys.traffic, bytes.traffic);
      await completeSimulationRequest({ workspaceId: WORKSPACE, userId: null, requestKey: claim.requestKey, fenceToken: claim.fenceToken, producer: "cpu:runner-2", completion });
      const done = await resolveSimulation(subject(content));
      assert.equal(done.state, "succeeded");
      assert.equal(done.state === "succeeded" && done.result.producer, "cpu:runner-2");
    } finally {
      process.env.SIMFORGE_SIMULATION_INLINE = "1";
    }
  });

  await t.test("a scenario error fails the request; an infrastructure error requeues it", async () => {
    setSimulationExecutorForTests(async () => { throw new Error("materialization_infeasible:[]"); });
    const failed = await resolveSimulation(subject({ roles: [], meta: { name: "infeasible" } }));
    assert.equal(failed.state, "failed");
    assert.equal(failed.state === "failed" && failed.failureCode, "materialization_infeasible");
    setSimulationExecutorForTests(async () => { throw new Error("map_artifact_download_failed:503"); });
    const retried = await resolveSimulation(subject({ roles: [], meta: { name: "flaky" } }));
    assert.equal(retried.state, "queued");
    const simulation = fakeSimulation("flaky");
    setSimulationExecutorForTests(async () => simulation);
    const recovered = await resolveSimulation(subject({ roles: [], meta: { name: "flaky" } }));
    assert.equal(recovered.state, "succeeded");
  });

  await t.test("a revision without a result is simulated lazily once and reports re-simulation", async () => {
    let executions = 0;
    const simulation = fakeSimulation("revision");
    setSimulationExecutorForTests(async () => { executions += 1; return simulation; });
    const content = { roles: [], meta: { name: "revision" } };
    await execute(`INSERT INTO simforge.datasets (id, workspace_id, name) VALUES ('usds_sim', :ws, 'sim') ON CONFLICT (id) DO NOTHING`, { ws: WORKSPACE });
    await execute(
      `INSERT INTO simforge.documents (id, workspace_id, dataset_id, title, schema_version, map_version_id)
       VALUES ('usdoc_sim', :ws, 'usds_sim', 'Sim', 'simforge.scenario/v1', :map) ON CONFLICT (id) DO NOTHING`,
      { ws: WORKSPACE, map: MAP_VERSION },
    );
    await execute(
      `INSERT INTO simforge.revisions (id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
         canonical_content, content_sha256, map_version_id, compiler_version)
       VALUES ('usrev_sim', :ws, 'usdoc_sim', 1, 1, 'simforge.scenario/v1', CAST(:content AS jsonb), :sha, :map, 'test')
       ON CONFLICT (id) DO NOTHING`,
      { ws: WORKSPACE, content, sha: contentHash(content), map: MAP_VERSION },
    );
    const first = await resolveRevisionSimulation({ workspaceId: WORKSPACE, userId: USER }, "usrev_sim");
    assert.equal(first?.state, "succeeded");
    assert.equal(first?.state === "succeeded" && first.resimulated, true);
    // Ten renders of one revision: one simulation.
    for (let render = 0; render < 10; render += 1) {
      const again = await resolveRevisionSimulation({ workspaceId: WORKSPACE, userId: USER }, "usrev_sim");
      assert.equal(again?.state === "succeeded" && again.result.simKey, simulation.simKey);
    }
    assert.equal(executions, 1);
    const link = await queryOne<{ origin: string }>(`SELECT origin FROM simforge.revision_simulations WHERE revision_id = 'usrev_sim'`);
    assert.equal(link?.origin, "lazy");
  });

  await t.test("the editor's verification is recorded as verified or as a mismatch", async () => {
    const simulation = fakeSimulation("memo");
    const verified = await recordSimulationVerification({ workspaceId: WORKSPACE, userId: USER, simKey: simulation.simKey, documentId: null, localTraceSha256: simulation.traceSha256, localRuntime: {} });
    assert.equal(verified?.outcome, "verified");
    const mismatch = await recordSimulationVerification({ workspaceId: WORKSPACE, userId: USER, simKey: simulation.simKey, documentId: null, localTraceSha256: DIGEST("f"), localRuntime: { userAgent: "test" } });
    assert.equal(mismatch?.outcome, "mismatch");
    assert.equal(await recordSimulationVerification({ workspaceId: WORKSPACE, userId: USER, simKey: DIGEST("0"), documentId: null, localTraceSha256: DIGEST("f"), localRuntime: {} }), null);
  });
});
