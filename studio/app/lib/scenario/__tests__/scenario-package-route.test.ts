import "../../models/__tests__/test-env";
// Stored containers are local objects signed with the supervised host's token.
process.env.SIMFORGE_LOCAL_HOST_TOKEN ??= "scenario-package-test-token";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { readScenarioPackage, verifyScenarioPackage } from "@simforge-oss/native-runtime";
import { serializeTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

import { migrate } from "../../../../scripts/migrate";
import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import { execute, queryOne, shutdownDatabase } from "@/app/lib/db/data-api";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";
import { putS3Object } from "@/app/lib/s3/s3-put-object";
import type { MapClosureMember, ScenarioPackageSources } from "../scenario-package/compose";
import { seedPinnedMap } from "./pinning-fixtures";

/**
 * `POST /api/simforge/revisions/:id/package` and `GET …/package/:exportId`
 * against a real (PGlite) database and the local object store: the flag,
 * request validation, revision access, the loud refusals of a revision that
 * is not ready (no simulation, no timeline, no OpenSCENARIO export), the thin
 * export (stored, verified, linked), and the full-form background job.
 *
 * The one revision that exports successfully reads its bytes from the crate's
 * fixture (fixtures/scenario-package/valid/full.scenario.zip) through a module
 * mock of the source reader; every other revision goes through the real one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, "../../../../../fixtures/scenario-package/valid/full.scenario.zip"));
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const FIXTURE_REVISION = "usrev_pkgfixture";

function fixtureSources(): { sources: ScenarioPackageSources; blobs: Map<string, Uint8Array>; mapMembers: MapClosureMember[] } {
  const read = readScenarioPackage(FIXTURE, { cliVersion: "0.2.0" });
  const member = (path: string) => new Uint8Array(read.members.find((m) => m.path === path)!.data);
  const m = JSON.parse(read.manifestJson) as Record<string, Record<string, unknown>>;
  const sim = m.simulation!;
  const map = m.map!;
  const catalog = m.catalog!;
  const content = JSON.parse(Buffer.from(member("document.json")).toString("utf8")) as ScenarioTemplateV2;
  const closure = JSON.parse(Buffer.from(member("map/closure.json")).toString("utf8")) as { members: MapClosureMember[] };
  const actorClosure = JSON.parse(Buffer.from(member("actors/closure.json")).toString("utf8")) as { members: Record<string, { sha256: string }> };
  const blobs = new Map(read.blobs.map((b) => [b.sha256, new Uint8Array(b.data)]));
  return {
    blobs,
    mapMembers: closure.members,
    sources: {
      revision: {
        id: FIXTURE_REVISION,
        documentId: "usdoc_pkgfixture",
        revisionNumber: 1,
        committedAt: "2026-09-24T00:00:00.000Z",
        title: "Cardboard box, Richmond loop",
        content,
        storedContentSha256: sha(serializeTemplate(content)),
        assetCatalogVersionId: catalog.assetCatalogVersionId as string,
        mapClosureSha256: null,
        ossRelease: null,
      },
      result: {
        simKey: sim.simKey as string,
        traceSha256: sim.traceSha256 as string,
        authoredTraceSha256: sim.authoredTraceSha256 as string,
        traceGzipSha256: sim.traceGzipSha256 as string,
        engineSemVer: m.engine!.engineSemVer as string,
        solverVer: m.engine!.solverVersion as string,
        traceSchema: sim.traceSchema as string,
        resolvedInputDigest: sim.resolvedInputDigest as string,
        resolutionSha256: sim.resolutionSha256 as string,
        mapClosureDigest: map.mapClosureDigest as string,
        mapVersionId: map.mapVersionId as string,
        trafficProvider: sim.trafficProvider as string,
        trafficStepKey: null,
        engineBuild: m.engine!.build as Record<string, unknown>,
        producer: "inline:test:1",
        createdAt: "2026-09-24T00:00:01.000Z",
        ambientProvenance: {},
      },
      traceGzip: member("simulation/trace.json.gz"),
      resolutionGzip: member("simulation/resolution.json.gz"),
      traffic: null,
      timeline: member(read.members.find((x) => x.path.startsWith("timeline/"))!.path),
      map: {
        mapVersionId: map.mapVersionId as string,
        sourceMapId: map.sourceMapId as string,
        label: map.label as string,
        xodrSha256: map.xodrSha256 as string,
        coordinateSystemSha256: map.coordinateSystemSha256 as string,
        browserClosureSha256: map.browserClosureSha256 as string,
        members: closure.members,
      },
      actors: { closure: member("actors/closure.json"), catalogModels: blobs.get(actorClosure.members["catalog-models.json"]!.sha256)! },
      catalogEntries: JSON.parse(Buffer.from(member("catalog/entries.json")).toString("utf8")) as unknown[],
      xosc: member("export/scenario.xosc"),
      sumo: null,
      pipelineRevision: 4,
      installation: { kind: "local-studio", id: "0b6c2f8e-6d1f-4b53-8f0e-1c2d3e4f5a6b" },
      motionSource: "original",
      appVersion: "0.1.0-rc.76",
    },
  };
}

const fixture = fixtureSources();
const deferred: (() => Promise<unknown> | unknown)[] = [];

// Module mocks, before the routes load: `after()` is captured (the test runs
// the job), the fixture revision reads the fixture, map members are served
// from it, and every other revision uses the real source reader.
const nextServer = await import("next/server");
mock.module("next/server", {
  namedExports: { ...nextServer, after: (task: () => Promise<unknown> | unknown) => void deferred.push(task) },
});
const realSources = await import("../scenario-package/sources.server");
mock.module("../scenario-package/sources.server", {
  namedExports: {
    ...realSources,
    readRevisionPackageSources: (workspaceId: string, revisionId: string) =>
      revisionId === FIXTURE_REVISION ? Promise.resolve(fixture.sources) : realSources.readRevisionPackageSources(workspaceId, revisionId),
  },
});
const realClosure = await import("../sim-closure.server");
mock.module("@/app/lib/scenario/sim-closure.server", {
  namedExports: {
    ...realClosure,
    readServerMapMember: async (_mapVersionId: string, relativePath: string) => {
      const listed = fixture.mapMembers.find((x) => x.relativePath === relativePath);
      const bytes = listed && fixture.blobs.get(listed.sha256);
      if (!bytes) throw new Error(`map_member_unavailable: ${relativePath}`);
      return bytes;
    },
  },
});

const { POST } = await import("../../../api/simforge/revisions/[revisionId]/package/route");
const { GET } = await import("../../../api/simforge/revisions/[revisionId]/package/[exportId]/route");

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const post = (revisionId: string, body?: unknown) =>
  POST(
    new Request(`http://localhost/api/simforge/revisions/${revisionId}/package`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params({ revisionId }),
  );
const get = (revisionId: string, exportId: string) =>
  GET(new Request(`http://localhost/api/simforge/revisions/${revisionId}/package/${exportId}`), params({ revisionId, exportId }));

type Dto = {
  exportId: string; state: string; form: string; packageId: string; fileName: string; sizeBytes: number | null;
  downloadUrl: string | null; cliCommand: string; error: { code: string } | null; summary: { title?: string; minCli?: string };
};

async function insertRevision(id: string, number: number, content: Record<string, unknown>): Promise<void> {
  await execute(
    `INSERT INTO simforge.revisions (id, workspace_id, document_id, revision_number, source_draft_version, schema_version,
       canonical_content, content_sha256, map_version_id, compiler_version)
     VALUES (:id, :ws, 'usdoc_pkg', :number, :number, 'simforge.scenario/v1', CAST(:content AS jsonb), :sha, 'usmapv_pin', 'test')
     ON CONFLICT (id) DO NOTHING`,
    { id, number, ws: LOCAL_WORKSPACE_ID, content, sha: sha(JSON.stringify(content)) },
  );
}

async function storedContainer(exportId: string): Promise<Uint8Array> {
  const row = await queryOne<{ storage_bucket: string; storage_key: string }>(
    `SELECT storage_bucket, storage_key FROM simforge.scenario_package_exports WHERE id = :id`,
    { id: exportId },
  );
  assert.ok(row, "the export row");
  return getS3ObjectBytes(row.storage_bucket, row.storage_key);
}

before(async () => {
  await migrate();
  await seedPinnedMap();
  await execute(
    `INSERT INTO simforge.documents (id, workspace_id, dataset_id, title, schema_version, map_version_id)
     VALUES ('usdoc_pkg', :ws, 'usds_pin', 'Package', 'simforge.scenario/v1', 'usmapv_pin') ON CONFLICT (id) DO NOTHING`,
    { ws: LOCAL_WORKSPACE_ID },
  );
  await insertRevision("usrev_pkg_nosim", 1, { roles: [], meta: { name: "no simulation" } });
  await insertRevision("usrev_pkg_notimeline", 2, { roles: [], meta: { name: "no timeline" } });
  await insertRevision(FIXTURE_REVISION, 3, { roles: [], meta: { name: "fixture" } });
  // A stored result with no timeline and no OpenSCENARIO export (the refusals never read its objects).
  const simKey = "9".repeat(64);
  await execute(
    `INSERT INTO simforge.sim_results (workspace_id, sim_key, trace_sha256, authored_trace_sha256, engine_sem_ver, solver_ver,
       trace_schema, resolved_input_digest, map_closure_digest, traffic_provider, map_version_id, producer, storage_bucket,
       trace_storage_key, trace_byte_length, trace_gzip_sha256, resolution_storage_key, resolution_byte_length, resolution_sha256)
     VALUES (:ws, :sim, :trace, :trace, '0.11.0', '0.11.0', 'simforge.trace/v5', :input, :closure, 'off', 'usmapv_pin',
       'inline:test:1', 'local-artifacts', 'none', 1, :trace, 'none', 1, :trace)`,
    { ws: LOCAL_WORKSPACE_ID, sim: simKey, trace: "8".repeat(64), input: "7".repeat(64), closure: "6".repeat(64) },
  );
  const { linkRevisionSimulation } = await import("../sim-result-store");
  await linkRevisionSimulation(null, { workspaceId: LOCAL_WORKSPACE_ID, revisionId: "usrev_pkg_notimeline", simKey, engineSemVer: "0.11.0", origin: "commit", userId: LOCAL_USER_ID });
});

after(async () => {
  await shutdownDatabase();
});

test("the flag gates both routes", async () => {
  process.env.SIMFORGE_SCENARIO_PACKAGE_EXPORT = "0";
  try {
    const refused = await post(FIXTURE_REVISION, {});
    assert.equal(refused.status, 404);
    assert.equal((await refused.json() as { error: string }).error, "scenario_package_export_disabled");
    assert.equal((await get(FIXTURE_REVISION, "uspkg_whatever0")).status, 404);
  } finally {
    delete process.env.SIMFORGE_SCENARIO_PACKAGE_EXPORT;
  }
});

test("requests are validated and scoped to revisions the caller can read", async () => {
  assert.equal((await post(FIXTURE_REVISION, { form: "zip" })).status, 400);
  assert.equal((await post(FIXTURE_REVISION, { form: "thin", textures: "exclude" })).status, 400);
  assert.equal((await post(FIXTURE_REVISION, { form: "thin", extra: 1 })).status, 400);
  assert.equal((await post("usrev_does_not_exist", {})).status, 404);
  assert.equal((await get(FIXTURE_REVISION, "uspkg_unknown000")).status, 404);
});

test("a revision that is not ready is refused loudly, naming the first gap", async () => {
  const noSim = await post("usrev_pkg_nosim", {});
  assert.equal(noSim.status, 409);
  assert.equal((await noSim.json() as { error: string }).error, "package_simulation_missing");

  const noTimeline = await post("usrev_pkg_notimeline", {});
  assert.equal(noTimeline.status, 409);
  const body = await noTimeline.json() as { error: string; message: string };
  assert.equal(body.error, "package_timeline_missing");
  assert.match(body.message, /Render the revision once/);

  // With a stored timeline, the missing OpenSCENARIO export is the next refusal.
  const timeline = Buffer.from('{"identity":{}}');
  await putS3Object("local-artifacts", "pkg-test/timeline.json", timeline, "application/json");
  await execute(
    `INSERT INTO simforge.sim_timelines (workspace_id, timeline_key, trace_sha256, height_field_digest, sampler_version,
       timeline_sha256, byte_length, storage_bucket, storage_key, stored_byte_length, stored_sha256, source_sim_key, producer)
     VALUES (:ws, :key, :trace, 'h', 'simforge.timeline-sampler/3', :sha, :len, 'local-artifacts', 'pkg-test/timeline.json', :len, :sha, :sim, 'test')`,
    { ws: LOCAL_WORKSPACE_ID, key: "5".repeat(64), trace: "8".repeat(64), sha: sha(timeline), len: timeline.byteLength, sim: "9".repeat(64) },
  );
  const noXosc = await post("usrev_pkg_notimeline", {});
  assert.equal(noXosc.status, 409);
  assert.equal((await noXosc.json() as { error: string }).error, "package_xosc_missing");

  const rows = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM simforge.scenario_package_exports WHERE revision_id IN ('usrev_pkg_nosim', 'usrev_pkg_notimeline')`,
  );
  assert.equal(rows?.n, 0, "a refused export writes nothing");
});

test("thin: written, verified, stored and linked in the request", async () => {
  const response = await post(FIXTURE_REVISION);
  assert.equal(response.status, 201);
  const dto = await response.json() as Dto;
  assert.equal(dto.state, "succeeded");
  assert.equal(dto.form, "thin");
  assert.match(dto.fileName, /^cardboard-box-richmond-loop\.[0-9a-f]{12}\.scenario\.zip$/);
  assert.equal(dto.fileName.split(".")[1], dto.packageId.slice(0, 12));
  assert.ok(dto.downloadUrl, "a download link");
  assert.match(dto.cliCommand, /^simforge package import cardboard-box-richmond-loop\.[0-9a-f]{12}\.scenario\.zip --into cardboard-box-richmond-loop && simforge render /);
  assert.equal(dto.summary.minCli, "0.2.0");

  const bytes = await storedContainer(dto.exportId);
  assert.equal(bytes.byteLength, dto.sizeBytes);
  const verification = verifyScenarioPackage(bytes, { cliVersion: "0.2.0" });
  assert.equal(verification.packageId, dto.packageId);
  assert.equal(verification.form, "thin");
  const manifest = verification.manifest as { producer: { app: string }; provenance: { installationKind: string } };
  assert.equal(manifest.producer.app, "simcloud");
  assert.equal(manifest.provenance.installationKind, "local-studio");

  const status = await get(FIXTURE_REVISION, dto.exportId);
  assert.equal(status.status, 200);
  assert.equal((await status.json() as Dto).state, "succeeded");
});

test("full: a background job builds, verifies and stores the container under the same package id", async () => {
  const thin = await (await post(FIXTURE_REVISION, { form: "thin" })).json() as Dto;
  deferred.length = 0;
  // Textures excluded: exactly the crate's full set.
  const response = await post(FIXTURE_REVISION, { form: "full", textures: "exclude" });
  assert.equal(response.status, 202);
  const queued = await response.json() as Dto;
  assert.equal(queued.state, "queued");
  assert.equal(queued.packageId, thin.packageId, "one revision, one id, either form");
  assert.equal(queued.downloadUrl, null);
  assert.equal(deferred.length, 1, "the job runs after the response");

  // The actor blobs come from the actor origin, verified by digest.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const digest = /\/([0-9a-f]{64})$/.exec(String(input))?.[1];
    const bytes = digest ? fixture.blobs.get(digest) : undefined;
    return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  try {
    await deferred.shift()!();
  } finally {
    globalThis.fetch = realFetch;
  }

  const done = await (await get(FIXTURE_REVISION, queued.exportId)).json() as Dto;
  assert.equal(done.state, "succeeded", JSON.stringify(done.error));
  assert.ok(done.downloadUrl);
  const verification = verifyScenarioPackage(await storedContainer(done.exportId), { cliVersion: "0.2.0" });
  assert.equal(verification.form, "full");
  assert.equal(verification.packageId, thin.packageId);
  assert.equal((verification.receipt as { textureTier?: string }).textureTier, "none");
});

test("full: over the host's limit is refused up front; a job that stops reporting is failed", async () => {
  process.env.SIMFORGE_SCENARIO_PACKAGE_FULL_MAX_BYTES = "1000";
  try {
    const refused = await post(FIXTURE_REVISION, { form: "full" });
    assert.equal(refused.status, 413);
    assert.equal((await refused.json() as { error: string }).error, "package_too_large");
  } finally {
    delete process.env.SIMFORGE_SCENARIO_PACKAGE_FULL_MAX_BYTES;
  }

  deferred.length = 0;
  const queued = await (await post(FIXTURE_REVISION, { form: "full" })).json() as Dto;
  deferred.length = 0; // the runner never starts (a killed function)
  await execute(
    `UPDATE simforge.scenario_package_exports SET created_at = NOW() - INTERVAL '1 hour' WHERE id = :id`,
    { id: queued.exportId },
  );
  const lost = await (await get(FIXTURE_REVISION, queued.exportId)).json() as Dto;
  assert.equal(lost.state, "failed");
  assert.equal(lost.error?.code, "package_job_lost");
});
