import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

import { bootModelTestDatabase, echoEndpointDescriptor } from "../../models/__tests__/harness";
import type { AppContext } from "../../db/app-context";
import { createModelEndpoint, createModelVersion } from "../../models/model-registry-store";
import { listModelRuns } from "../../models/model-run-store";
import {
  launchComparison,
  readComputeCapabilities,
  type ComparisonLaunchRequest,
  type ComputeCapabilities,
} from "../comparison-launch";
import {
  COMPARISON_SCHEMA,
  listComparisons,
  readComparison,
  writeComparison,
} from "../comparison-store";

let context: AppContext;
/** Installed locally, with an enabled endpoint: a launchable local column. */
let installedVersionId: string;
/** In the registry but with no endpoint: a family that cannot be leased. */
let endpointlessVersionId: string;

const digest = (seed: string) => seed.repeat(64).slice(0, 64);

before(async () => {
  context = await bootModelTestDatabase();
  const installed = await createModelVersion(context, {
    family: "alpamayo-1",
    name: "A1 nf4",
    source: "hf:nvidia/alpamayo-1",
    checkpointDigest: digest("a"),
    quant: "nf4",
    license: "OpenMDW-1.1",
  });
  assert.equal(installed.kind, "created");
  installedVersionId = installed.kind === "created" ? installed.version.id : "";
  const endpoint = await createModelEndpoint(context, {
    modelVersionId: installedVersionId,
    name: "local-a1",
    descriptor: echoEndpointDescriptor("/tmp/echo.mjs"),
  });
  assert.equal(endpoint.kind, "created");

  const bare = await createModelVersion(context, {
    family: "alpamayo-2-super",
    name: "A2 fp16",
    source: "hf:nvidia/alpamayo-2-super",
    checkpointDigest: digest("b"),
    quant: "fp16",
    license: "OpenMDW-1.1",
  });
  assert.equal(bare.kind, "created");
  endpointlessVersionId = bare.kind === "created" ? bare.version.id : "";
});

const request = (
  overrides: Partial<ComparisonLaunchRequest> = {},
): ComparisonLaunchRequest => ({
  campaignId: "cmp-campaign",
  kind: "closedloop-episode",
  spec: "fixtures/synthetic-leadcar.episodes.json",
  seeds: [1, 2],
  steps: 50,
  decisionHz: 10,
  mode: "offline-simtime",
  deadlineMs: null,
  frameSource: "dir:/tmp/frames",
  cloudInputs: [{ role: "scenario", artifactId: "art-scenario-1" }],
  columns: [
    { modelVersionId: installedVersionId, target: "local", rigProfile: "alpamayo-4cam", quant: "nf4" },
  ],
  ...overrides,
});

/** A cloud service that serves open loop only — the case Main called out. */
const openloopOnlyCloud: ComputeCapabilities = {
  enabled: true,
  families: [
    {
      family: "alpamayo-2-super",
      available: true,
      kinds: ["alpamayo.openloop"],
      quants: ["fp16"],
      pinnedRevision: "rev-777",
    },
  ],
};

test("a local column submits one real run per seed", async () => {
  const result = await launchComparison(context, request({ seeds: [4, 5, 6] }));
  assert.equal(result.refused.length, 0);
  assert.equal(result.launched.length, 1);
  assert.equal(result.launched[0]!.runIds.length, 3);
  const runs = await listModelRuns(context);
  for (const runId of result.launched[0]!.runIds) {
    assert.ok(runs.some((run) => run.id === runId));
  }
});

test("a local column records the identity it was submitted with", async () => {
  const result = await launchComparison(context, request());
  const identity = result.launched[0]!.identity;
  assert.equal(identity.family, "alpamayo-1");
  assert.equal(identity.quant, "nf4");
  assert.equal(identity.checkpointDigest, digest("a"));
  assert.equal(identity.rigProfile, "alpamayo-4cam");
});

test("a model with no enabled endpoint cannot be leased locally", async () => {
  const result = await launchComparison(
    context,
    request({
      columns: [
        { modelVersionId: endpointlessVersionId, target: "local", rigProfile: "alpamayo-4cam", quant: "fp16" },
      ],
    }),
  );
  assert.equal(result.launched.length, 0);
  assert.equal(result.refused[0]!.code, "no_local_endpoint");
});

test("an open-loop-only cloud service refuses a closed-loop column", async () => {
  // The heart of it: the family IS available and the quant IS served, but not
  // for this kind. Readiness per family would have submitted this.
  const result = await launchComparison(
    context,
    request({
      kind: "closedloop-episode",
      columns: [
        { modelVersionId: endpointlessVersionId, target: "cloud", rigProfile: "alpamayo-4cam", quant: "fp16" },
      ],
    }),
    { capabilities: openloopOnlyCloud, submitComputeJob: async () => "job-never" },
  );
  assert.equal(result.launched.length, 0);
  assert.equal(result.refused[0]!.code, "kind_unsupported_on_target");
  assert.match(result.refused[0]!.reason, /alpamayo\.closedloop-episode/);
});

test("the same service accepts the open-loop kind it does serve", async () => {
  const submitted: unknown[] = [];
  const result = await launchComparison(
    context,
    request({
      kind: "openloop",
      seeds: [9],
      cloudInputs: [{ role: "clip-bundle", artifactId: "art-clip-1" }],
      columns: [
        { modelVersionId: endpointlessVersionId, target: "cloud", rigProfile: "alpamayo-4cam", quant: "fp16" },
      ],
    }),
    {
      capabilities: openloopOnlyCloud,
      submitComputeJob: async (body) => {
        submitted.push(body);
        return "job-1";
      },
    },
  );
  assert.equal(result.refused.length, 0);
  assert.deepEqual(result.launched[0]!.runIds, ["job-1"]);
  const job = submitted[0] as {
    kind: string;
    idempotencyKey: string;
    input: {
      model: { revision: string | null };
      inputs: { role: string; artifactId: string }[];
      params: Record<string, unknown>;
    };
  };
  assert.equal(job.kind, "alpamayo.openloop");
  // `model` and `inputs` live INSIDE `input`; params carry no path or URL,
  // because the compute worker dereferences nothing from params.
  assert.equal(job.input.model.revision, "rev-777");
  assert.deepEqual(job.input.inputs, [{ role: "clip-bundle", artifactId: "art-clip-1" }]);
  assert.deepEqual(job.input.params["items"], [{ role: "clip-bundle" }]);
  for (const [key, value] of Object.entries(job.input.params)) {
    if (typeof value !== "string") continue;
    assert.ok(!/^[a-z]+:|\//.test(value), `params.${key} must not be path- or URL-shaped: ${value}`);
  }
  // One key per campaign/column/seed, so a retry joins instead of racing.
  assert.equal(job.idempotencyKey, `cmp-campaign:${endpointlessVersionId}:9`);
});

test("an unserved quantization is refused with what the service does serve", async () => {
  const result = await launchComparison(
    context,
    request({
      kind: "openloop",
      cloudInputs: [{ role: "clip-bundle", artifactId: "art-clip-1" }],
      columns: [
        { modelVersionId: endpointlessVersionId, target: "cloud", rigProfile: "alpamayo-4cam", quant: "nf4" },
      ],
    }),
    { capabilities: openloopOnlyCloud, submitComputeJob: async () => "job-never" },
  );
  assert.equal(result.refused[0]!.code, "quant_unsupported_on_target");
  assert.match(result.refused[0]!.reason, /fp16/);
});

test("no compute service means no cloud column, with the reason carried through", async () => {
  const result = await launchComparison(
    context,
    request({
      columns: [
        { modelVersionId: endpointlessVersionId, target: "cloud", rigProfile: "alpamayo-4cam", quant: "fp16" },
      ],
    }),
    { capabilities: null, capabilitiesReason: "compute capabilities did not return JSON" },
    );
  assert.equal(result.refused[0]!.code, "compute_unavailable");
  assert.equal(result.refused[0]!.reason, "compute capabilities did not return JSON");
});

test("a local column with no frame source is refused instead of inventing pixels", async () => {
  const result = await launchComparison(context, request({ frameSource: null }));
  assert.equal(result.launched.length, 0);
  assert.equal(result.refused[0]!.code, "no_frame_source");
  assert.match(result.refused[0]!.reason, /never synthesized/);
});

test("a cloud column needs uploaded artifacts, not a path on this machine", async () => {
  // The compute params schema rejects path- and URL-shaped values because the
  // worker dereferences nothing from params: a file arrives only as an artifact
  // bound to a role. A cloud column asked for without one is refused here.
  const result = await launchComparison(
    context,
    request({
      kind: "openloop",
      cloudInputs: [],
      columns: [
        { modelVersionId: endpointlessVersionId, target: "cloud", rigProfile: "alpamayo-4cam", quant: "fp16" },
      ],
    }),
    { capabilities: openloopOnlyCloud, submitComputeJob: async () => "job-never" },
  );
  assert.equal(result.launched.length, 0);
  assert.equal(result.refused[0]!.code, "cloud_inputs_required");
  assert.match(result.refused[0]!.reason, /never a path on this machine/);
});

test("a cloud column runs while a local column lacking frames is refused", async () => {
  // The two refusals are independent: a cloud-only comparison needs no local
  // frame source, and a local column's missing frames does not sink the cloud.
  const result = await launchComparison(
    context,
    request({
      kind: "openloop",
      seeds: [3],
      frameSource: null,
      cloudInputs: [{ role: "clip-bundle", artifactId: "art-clip-1" }],
      columns: [
        { modelVersionId: installedVersionId, target: "local", rigProfile: "alpamayo-4cam", quant: "nf4" },
        { modelVersionId: endpointlessVersionId, target: "cloud", rigProfile: "alpamayo-4cam", quant: "fp16" },
      ],
    }),
    { capabilities: openloopOnlyCloud, submitComputeJob: async () => "job-y" },
  );
  assert.deepEqual(
    result.refused.map((entry) => entry.code),
    ["no_frame_source"],
  );
  assert.equal(result.launched.length, 1);
  assert.equal(result.launched[0]!.target, "cloud");
});

test("a partly submitted column says how many runs already exist", async () => {
  let calls = 0;
  const result = await launchComparison(
    context,
    request({
      kind: "openloop",
      seeds: [1, 2, 3],
      cloudInputs: [{ role: "clip-bundle", artifactId: "art-clip-1" }],
      columns: [
        { modelVersionId: endpointlessVersionId, target: "cloud", rigProfile: "alpamayo-4cam", quant: "fp16" },
      ],
    }),
    {
      capabilities: openloopOnlyCloud,
      submitComputeJob: async () => {
        calls += 1;
        if (calls > 1) throw new Error("provider rejected the second job");
        return "job-a";
      },
    },
  );
  assert.equal(result.launched.length, 0);
  assert.equal(result.refused[0]!.code, "submission_failed");
  // The accepted job is not disowned: it exists and will run.
  assert.match(result.refused[0]!.reason, /1 job\(s\) were already accepted/);
});

test("a mixed request launches what can run and refuses the rest", async () => {
  const result = await launchComparison(
    context,
    request({
      seeds: [11],
      columns: [
        { modelVersionId: installedVersionId, target: "local", rigProfile: "alpamayo-4cam", quant: "nf4" },
        { modelVersionId: endpointlessVersionId, target: "cloud", rigProfile: "alpamayo-4cam", quant: "fp16" },
      ],
    }),
    { capabilities: openloopOnlyCloud, submitComputeJob: async () => "job-x" },
  );
  assert.equal(result.launched.length, 1);
  assert.equal(result.launched[0]!.target, "local");
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0]!.code, "kind_unsupported_on_target");
});

test("an unknown model version is refused, not submitted", async () => {
  const result = await launchComparison(
    context,
    request({
      columns: [
        { modelVersionId: "mv-does-not-exist", target: "local", rigProfile: "alpamayo-4cam", quant: "nf4" },
      ],
    }),
  );
  assert.equal(result.refused[0]!.code, "model_version_not_found");
});

test("capabilities: a non-JSON body is unavailable, not a crash", async () => {
  const html = new Response("<!doctype html><p>not here", { status: 200 });
  const result = await readComputeCapabilities(async () => html, "http://localhost:3025");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /did not return JSON/);
});

test("capabilities: an absent route is unavailable with its status", async () => {
  const missing = new Response("", { status: 404 });
  const result = await readComputeCapabilities(async () => missing, "http://localhost:3025");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /HTTP 404/);
});

test("the comparison record round-trips, and a path-shaped id cannot escape the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmp-store-"));
  process.env.SIMFORGE_RUNS_ROOT = root;
  const record = {
    schema: COMPARISON_SCHEMA,
    comparisonId: "cmp-abc123",
    campaignId: "camp-1",
    kind: "closedloop-episode" as const,
    createdAt: new Date().toISOString(),
    shared: {
      spec: "fixtures/x.episodes.json",
      seeds: [1, 2],
      steps: 50,
      decisionHz: 10,
      mode: "offline-simtime" as const,
      deadlineMs: null,
      frameSource: "dir:/tmp/frames",
      cloudInputs: [{ role: "scenario", artifactId: "art-scenario-1" }],
    },
    columns: [
      {
        label: "A1 nf4 (local)",
        target: "local" as const,
        modelVersionId: "mv-1",
        identity: {
          family: "alpamayo-1",
          revision: null,
          quant: "nf4",
          checkpointDigest: digest("a"),
          rigProfile: "alpamayo-4cam",
        },
        runIds: ["run-1", "run-2"],
      },
    ],
    // Refusals are kept BESIDE the columns, so the page can say what a person
    // asked for and could not have rather than quietly showing fewer columns.
    refused: [
      {
        modelVersionId: "mv-2",
        target: "cloud" as const,
        code: "kind_unsupported_on_target",
        reason: "The deployed service does not run alpamayo.closedloop-episode.",
      },
    ],
  };
  await writeComparison(record);
  const read = await readComparison("cmp-abc123");
  assert.deepEqual(read, record);
  assert.equal((await listComparisons("camp-1")).length, 1);
  assert.equal((await listComparisons("other-campaign")).length, 0);

  assert.equal(await readComparison("../../etc/passwd"), null);
  await assert.rejects(
    writeComparison({ ...record, comparisonId: "../escape" }),
    /unsafe comparison id/,
  );
});
