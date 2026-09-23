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
  failSimulationRequest,
  completeSimulationRequest,
  evaluateSimulationResult,
  getSimulationResult,
  recordSimulationVerification,
  reserveSimulationJobOutputs,
  linkRevisionSimulation,
  resimulateRevision,
  resolveRevisionReplay,
  resolveSimulation,
  revisionMotion,
  RevisionReplayError,
  setRevisionActiveSimulation,
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

function fakeSimulation(seed: string, overrides: { simKeySeed?: string; speed?: number; engineSemVer?: string } = {}): AuthoritativeSimulation {
  const engineSemVer = overrides.engineSemVer ?? "0.8.0";
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
    engineSemVer,
    solverVer: engineSemVer,
    traceSchema: TRACE_SCHEMA,
  });
  return {
    simKey: key,
    traceSha256,
    authoredTraceSha256: traceSha256,
    trafficStepKey: null,
    resolvedInputDigest,
    mapClosureDigest: DIGEST("e"),
    engineSemVer,
    solverVer: engineSemVer,
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
    // Evaluation reads the same stored trace by key.
    const evaluated = await evaluateSimulationResult(WORKSPACE, simulation.simKey);
    assert.equal(evaluated?.traceSha256, simulation.traceSha256);
    assert.ok(["accept", "reject"].includes(evaluated?.evaluation.verdict ?? ""));
    assert.equal(await evaluateSimulationResult(WORKSPACE, DIGEST("0")), null);
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

  await t.test("a SUMO document's runner claim carries its network members and the pinned runtime; others do not", async () => {
    await execute(`UPDATE simforge.map_versions SET sumo_network_sha256 = :sha WHERE id = :id`, { id: MAP_VERSION, sha: DIGEST("5") });
    for (const [index, relativePath] of ["map.xodr", "derived/sumo/sumo-network-manifest.json", "derived/sumo/map.net.xml"].entries()) {
      await execute(
        `INSERT INTO simforge.browser_asset_blobs (id, storage_bucket, storage_key, sha256, byte_length, media_type, verification_state)
         VALUES (:id, 'local-artifacts', :key, :sha, 1, :media, 'verified') ON CONFLICT DO NOTHING`,
        { id: `usbab_sumo_${index}`, key: `maps/${relativePath}`, sha: DIGEST(String(6 + index)), media: `application/x-test-${index}` },
      );
      await execute(
        `INSERT INTO simforge.browser_asset_members (asset_set_id, relative_path, blob_id, role)
         VALUES ('usbas_sim', :path, :blob, 'metadata') ON CONFLICT DO NOTHING`,
        { path: relativePath, blob: `usbab_sumo_${index}` },
      );
    }
    process.env.SIMFORGE_SIMULATION_INLINE = "0";
    try {
      const sumo = { roles: [], meta: { name: "sumo-claim" }, extensions: { "studio.ambientTraffic.provider.v1": "sumo" } };
      const plain = { roles: [], meta: { name: "plain-claim" } };
      const sumoRequest = await resolveSimulation(subject(sumo));
      const plainRequest = await resolveSimulation(subject(plain));
      const claims = [await claimSimulationJob({ workerId: "runner-3", leaseSeconds: 300 }), await claimSimulationJob({ workerId: "runner-3", leaseSeconds: 300 })];
      const sumoClaim = claims.find((claim) => claim?.requestKey === sumoRequest.requestKey);
      const plainClaim = claims.find((claim) => claim?.requestKey === plainRequest.requestKey);
      assert.ok(sumoClaim && plainClaim);
      assert.equal(sumoClaim.map.sumoNetworkSha256, DIGEST("5"));
      assert.deepEqual(
        sumoClaim.map.members.map((member) => member.relativePath).filter((path) => path.startsWith("derived/sumo/")).sort(),
        ["derived/sumo/map.net.xml", "derived/sumo/sumo-network-manifest.json"],
      );
      assert.deepEqual(sumoClaim.sumoRuntime?.map((file) => file.file), ["sumo.mjs", "sumo.wasm", "runtime-manifest.json"]);
      assert.ok(sumoClaim.sumoRuntime?.every((file) => file.downloadUrl.includes("sumo-runtime")));
      assert.equal(plainClaim.sumoRuntime, null);
      assert.ok(plainClaim.map.members.every((member) => !member.relativePath.startsWith("derived/sumo/")));
      for (const claim of [sumoClaim, plainClaim]) {
        await failSimulationRequest({ workspaceId: WORKSPACE, requestKey: claim.requestKey, fenceToken: claim.fenceToken, code: "test_done", message: "", retryable: false });
      }
    } finally {
      process.env.SIMFORGE_SIMULATION_INLINE = "1";
      await execute(`UPDATE simforge.map_versions SET sumo_network_sha256 = NULL WHERE id = :id`, { id: MAP_VERSION });
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

  await t.test("renders replay a revision's original result; re-simulation is explicit and never moves it", async () => {
    await execute(`INSERT INTO simforge.datasets (id, workspace_id, name) VALUES ('usds_sim', :ws, 'sim') ON CONFLICT (id) DO NOTHING`, { ws: WORKSPACE });
    await execute(
      `INSERT INTO simforge.documents (id, workspace_id, dataset_id, title, schema_version, map_version_id)
       VALUES ('usdoc_sim', :ws, 'usds_sim', 'Sim', 'simforge.scenario/v1', :map) ON CONFLICT (id) DO NOTHING`,
      { ws: WORKSPACE, map: MAP_VERSION },
    );
    const revision = async (id: string, number: number, content: Record<string, unknown>) => execute(
      `INSERT INTO simforge.revisions (id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
         canonical_content, content_sha256, map_version_id, compiler_version)
       VALUES (:id, :ws, 'usdoc_sim', :number, :number, 'simforge.scenario/v1', CAST(:content AS jsonb), :sha, :map, 'test')
       ON CONFLICT (id) DO NOTHING`,
      { id, number, ws: WORKSPACE, content, sha: contentHash(content), map: MAP_VERSION },
    );
    const context = { workspaceId: WORKSPACE, userId: USER };
    const { TIMELINE_SAMPLER_VERSION } = await import("@simforge-oss/render/timeline");
    const registerTimeline = async (traceSha256: string, simKey: string, sampler: string, seedChar: string) => execute(
      `INSERT INTO simforge.sim_timelines (workspace_id, timeline_key, trace_sha256, height_field_digest, sampler_version,
         timeline_sha256, byte_length, storage_bucket, storage_key, stored_byte_length, stored_sha256, source_sim_key, producer)
       VALUES (:ws, :key, :trace, 'test-height', :sampler, :sha, 10, 'local-artifacts', :object, 10, :sha, :sim, 'test')`,
      { ws: WORKSPACE, key: DIGEST(seedChar), trace: traceSha256, sampler, sha: DIGEST(seedChar), object: `timelines/${seedChar}`, sim: simKey },
    );

    // A revision committed before worker simulation has no stored result:
    // rendering it is refused, and nothing is simulated behind the user's back.
    let executions = 0;
    const legacyContent = { roles: [], meta: { name: "legacy" } };
    await revision("usrev_legacy", 1, legacyContent);
    setSimulationExecutorForTests(async () => { executions += 1; return fakeSimulation("legacy"); });
    await assert.rejects(resolveRevisionReplay(context, "usrev_legacy"), (error: unknown) =>
      error instanceof RevisionReplayError && error.code === "original_simulation_missing");
    assert.equal(executions, 0);
    assert.equal((await revisionMotion(WORKSPACE, "usrev_legacy"))?.active, null);
    // The legacy OpenSCENARIO replay is explicit, and only offered when an export exists.
    await assert.rejects(resolveRevisionReplay(context, "usrev_legacy", { motionSource: "original-xosc" }), (error: unknown) =>
      error instanceof RevisionReplayError && error.code === "legacy_xosc_unavailable");

    // Explicit re-simulation adds a result without making it the default.
    const explicit = await resimulateRevision(context, "usrev_legacy");
    assert.equal(explicit?.status.state, "succeeded");
    assert.equal(executions, 1);
    assert.equal(explicit?.motion.active, null);
    assert.equal(explicit?.motionDiff, null);
    const bound = explicit?.status.state === "succeeded" ? explicit.status.result.simKey : "";
    assert.equal(explicit?.motion.results.length, 1);
    // Its render is explicit too, and needs a timeline: none can be derived
    // for this test map, and that is an error, never an xosc fallback.
    await assert.rejects(resolveRevisionReplay(context, "usrev_legacy", { motionSource: "resimulated", simKey: bound }), (error: unknown) =>
      error instanceof RevisionReplayError && error.code === "render_timeline_unavailable");

    // A committed revision: its commit result is the active one.
    const original = fakeSimulation("original", { engineSemVer: "0.9.0", speed: 8 });
    const content = { roles: [], meta: { name: "original" } };
    await revision("usrev_original", 2, content);
    setSimulationExecutorForTests(async () => original);
    const committed = await resolveSimulation(subject(content));
    assert.equal(committed.state, "succeeded");
    await linkRevisionSimulation(null, { workspaceId: WORKSPACE, revisionId: "usrev_original", simKey: original.simKey, engineSemVer: "0.9.0", origin: "commit" });
    await registerTimeline(original.traceSha256, original.simKey, TIMELINE_SAMPLER_VERSION, "a");
    // A timeline of an older sampler for the same trace is never rendered.
    await registerTimeline(original.traceSha256, original.simKey, "simforge.timeline-sampler/0", "9");
    const replay = await resolveRevisionReplay(context, "usrev_original");
    assert.equal(replay.kind, "simulation");
    assert.equal(replay.kind === "simulation" && replay.motionSource, "original");
    assert.equal(replay.kind === "simulation" && replay.result.simKey, original.simKey);
    assert.equal(replay.kind === "simulation" && replay.timeline.timelineSha256, DIGEST("a"));

    // A newer engine: re-simulating is explicit, reports the motion diff and
    // leaves the original as what renders.
    const newer = fakeSimulation("original", { engineSemVer: "0.10.0", speed: 11 });
    setSimulationExecutorForTests(async () => newer);
    // A new engine build changes the request key; stand in for it by
    // retiring the memoized request of this content.
    await execute(`DELETE FROM simforge.sim_requests WHERE workspace_id = :ws AND content_sha256 = :sha`, { ws: WORKSPACE, sha: contentHash(content) });
    const resim = await resimulateRevision(context, "usrev_original");
    assert.equal(resim?.status.state, "succeeded");
    assert.equal(resim?.motion.active?.simKey, original.simKey);
    assert.equal(resim?.motion.active?.original, true);
    assert.equal(resim?.motionDiff?.identical, false);
    assert.ok((resim?.motionDiff?.maxPositionDeltaM ?? 0) > 0.001);
    assert.equal(resim?.motionDiff?.base.engineSemVer, "0.9.0");
    assert.equal(resim?.motionDiff?.candidate.engineSemVer, "0.10.0");
    const again = await resolveRevisionReplay(context, "usrev_original");
    assert.equal(again.kind === "simulation" && again.result.simKey, original.simKey);
    // A commit never overrides the pointer; the user can move it, only to a bound result.
    await linkRevisionSimulation(null, { workspaceId: WORKSPACE, revisionId: "usrev_original", simKey: newer.simKey, engineSemVer: "0.10.0", origin: "commit" });
    assert.equal((await revisionMotion(WORKSPACE, "usrev_original"))?.active?.simKey, original.simKey);
    await assert.rejects(
      setRevisionActiveSimulation(null, { workspaceId: WORKSPACE, revisionId: "usrev_original", simKey: bound, reason: "user", userId: USER }),
      (error: unknown) => error instanceof RevisionReplayError && error.code === "revision_simulation_not_bound",
    );
    await setRevisionActiveSimulation(null, { workspaceId: WORKSPACE, revisionId: "usrev_original", simKey: newer.simKey, reason: "user", userId: USER });
    const moved = await revisionMotion(WORKSPACE, "usrev_original");
    assert.equal(moved?.active?.simKey, newer.simKey);
    assert.equal(moved?.active?.original, false);
    assert.equal(moved?.active?.reason, "user");
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
