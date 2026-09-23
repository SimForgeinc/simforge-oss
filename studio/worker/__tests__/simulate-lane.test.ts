import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import {
  gzipTrace,
  materializeTraceTraffic,
  simKey,
  TRACE_SCHEMA,
  type AuthoritativeSimulation,
} from "@simforge-oss/compiler/node";
import { contentHash } from "@simforge-oss/engine";
import { runSimulation, traceDigest } from "@simforge-oss/engine/node";

import {
  LANE_LEFT,
  scenario,
  syntheticGraph,
  vehicle,
} from "../../../packages/engine/src/__tests__/fixtures/scenarios";
import { claimMemberFetcher, processSimulationJob, SimulationJobClient, type SimulationJobClaim } from "../simulate";

/** The local worker's simulate lane: claim → simulate → reserve → upload → complete, fenced. */

const DIGEST = (c: string) => c.repeat(64);
const graph = syntheticGraph();

function simulation(): AuthoritativeSimulation {
  const result = runSimulation(scenario({
    seed: "simulate-lane",
    actors: [vehicle(graph, { id: "ego", rsl: LANE_LEFT, s: 60, speedMps: 10, cruiseSpeedMps: 10 })],
  }), { graph });
  const digest = contentHash(result.input);
  const traceGzip = gzipTrace(result.trace);
  return {
    simKey: simKey({ resolvedInputDigest: digest, mapClosureDigest: DIGEST("e"), engineSemVer: "0.8.0", solverVer: "0.8.0", traceSchema: TRACE_SCHEMA }),
    traceSha256: traceDigest(result.trace),
    authoredTraceSha256: traceDigest(result.trace),
    trafficStepKey: null,
    resolvedInputDigest: digest,
    mapClosureDigest: DIGEST("e"),
    engineSemVer: "0.8.0",
    solverVer: "0.8.0",
    traceSchema: TRACE_SCHEMA,
    engineBuild: {},
    provider: "off",
    resolved: {
      template: {} as never,
      axisUntilClamps: [],
      concrete: { input: result.input, siteId: "s", materialization: {}, ambientTraffic: { actors: [] } as never },
      resolvedInput: result.input,
      executedInput: result.input,
    },
    trace: result.trace,
    traceGzip,
    traceGzipSha256: createHash("sha256").update(traceGzip).digest("hex"),
    traffic: materializeTraceTraffic({
      provider: "off", profile: {} as never, sourceInputDigest: digest,
      map: { assetId: "map", versionId: "usmapv" }, trace: result.trace, ambientActorIds: [],
    }),
    simulateMs: 1,
  };
}

function claimBody(): SimulationJobClaim {
  return {
    contract: "simforge.sim-job-claim/v1",
    workspaceId: "ws_1",
    requestKey: DIGEST("a"),
    fenceToken: "f".repeat(64),
    leaseExpiresAt: "2026-09-22T00:00:00.000Z",
    contentSha256: DIGEST("c"),
    canonicalContent: { roles: [] },
    catalogEntries: [],
    map: {
      mapVersionId: "usmapv_1",
      mapAssetId: "map-1",
      browserClosureSha256: DIGEST("d"),
      members: ["3d/manifest.json", "topology-index.json.gz", "derived/topology-derived.json.gz", "derived/locations.json.gz", "map.xodr", "signals.geojson.gz"]
        .map((relativePath, index) => ({ relativePath, sha256: DIGEST(String(index)), sizeBytes: 1, downloadUrl: `/api/local-objects/${relativePath}?sig` })),
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("local worker simulate lane", () => {
  test("claims, uploads to each reservation (resolving relative URLs) and completes under the fence", async () => {
    const calls: string[] = [];
    let completion: { fenceToken?: string; workerId?: string } = {};
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/claim")) return json(claimBody());
      if (url.pathname.endsWith("/reserve")) {
        return json({
          trace: { uploadRequired: true, uploadUrl: "/api/local-objects/trace?sig", mediaType: "a" },
          resolution: { uploadRequired: true, uploadUrl: "https://bucket.s3.amazonaws.com/resolution", mediaType: "b" },
          traffic: { uploadRequired: false, uploadUrl: null, mediaType: "c" },
        });
      }
      if (init?.method === "PUT") return new Response(null, { status: 200 });
      if (url.pathname.endsWith("/complete")) { completion = JSON.parse(String(init?.body)); return json({ ok: true }); }
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    const client = new SimulationJobClient(new URL("http://127.0.0.1:5199"), "token", fetchMock);
    assert.equal(await processSimulationJob(client, "worker-1", async () => ({ simulation: simulation(), timeline: null })), true);
    assert.deepEqual(calls, [
      "POST /api/simforge/internal/sim-jobs/claim",
      `POST /api/simforge/internal/sim-jobs/${DIGEST("a")}/reserve`,
      "PUT /api/local-objects/trace",
      "PUT /resolution",
      `POST /api/simforge/internal/sim-jobs/${DIGEST("a")}/complete`,
    ]);
    assert.equal(completion.fenceToken, "f".repeat(64));
    assert.equal(completion.workerId, "worker-1");
  });

  test("reports idle when nothing is queued", async () => {
    const client = new SimulationJobClient(new URL("http://127.0.0.1:5199"), "token", (async () => new Response(null, { status: 204 })) as typeof fetch);
    assert.equal(await processSimulationJob(client, "worker-1"), false);
  });

  test("fails scenario errors for good and infrastructure errors as retryable", async () => {
    for (const [message, retryable] of [["materialization_infeasible:[]", false], ["map_artifact_download_failed:503", true]] as const) {
      const failures: Array<{ code: string; retryable: boolean }> = [];
      const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/claim")) return json(claimBody());
        if (url.endsWith("/fail")) { failures.push(JSON.parse(String(init?.body))); return json({ ok: true }); }
        return new Response(null, { status: 500 });
      }) as typeof fetch;
      const client = new SimulationJobClient(new URL("http://127.0.0.1:5199"), "token", fetchMock);
      await processSimulationJob(client, "worker-1", async () => { throw new Error(message); });
      assert.equal(failures.length, 1);
      assert.equal(failures[0]!.code, message.split(":")[0]);
      assert.equal(failures[0]!.retryable, retryable);
    }
  });

  test("never fails a request another executor holds", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/claim")) return json(claimBody());
      if (url.endsWith("/reserve")) return json({ error: "sim_job_lease_lost" }, 409);
      if (url.endsWith("/fail")) throw new Error("must not fail a request another executor holds");
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    const client = new SimulationJobClient(new URL("http://127.0.0.1:5199"), "token", fetchMock);
    assert.equal(await processSimulationJob(client, "worker-1", async () => ({ simulation: simulation(), timeline: null })), true);
  });

  test("resolves the editor loader's member URLs to the claim's objects only", async () => {
    const seen: string[] = [];
    const base = "https://simulation-closure.invalid/k/";
    const claim = claimBody();
    const xodr = claim.map.members.find((member) => member.relativePath === "map.xodr")!;
    xodr.sha256 = createHash("sha256").update("ok").digest("hex");
    let body = "ok";
    const fetcher = claimMemberFetcher(claim, base, new URL("http://127.0.0.1:5199"), (async (target: URL) => { seen.push(String(target)); return new Response(body); }) as never);
    const response = await fetcher(`${base}map.xodr`);
    // Root-relative local-object URLs resolve against the host, never the synthetic closure base.
    assert.deepEqual(seen, ["http://127.0.0.1:5199/api/local-objects/map.xodr?sig"]);
    // Presigned object-store GETs carry no digest header: the claim's digest is verified and attested.
    assert.equal(response.headers.get("x-content-sha256"), xodr.sha256);
    body = "tampered";
    await assert.rejects(fetcher(`${base}map.xodr`), /simulation_map_member_digest_mismatch:map.xodr/);
    assert.equal((await fetcher(`${base}unknown.bin`)).status, 404);
    await assert.rejects(fetcher("https://elsewhere.example/map.xodr"), /outside the claimed closure/);
  });
});
