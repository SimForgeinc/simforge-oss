import "../../app/lib/models/__tests__/test-env";

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, after, test } from "node:test";

import { TEST_RUNS_ROOT } from "../../app/lib/models/__tests__/test-env";
import { bootModelTestDatabase } from "../../app/lib/models/__tests__/harness";
import type { AppContext } from "../../app/lib/db/app-context";
import { CreateModelEndpointSchema, CreateModelRunSchema } from "../../app/lib/models/contracts";
import {
  createModelEndpoint,
  createModelVersion,
} from "../../app/lib/models/model-registry-store";
import { createModelRun, getModelRun } from "../../app/lib/models/model-run-store";
import { runModelRunLoop } from "../model-run";

const STUB_SCRIPT = join(import.meta.dirname, "..", "testing", "echo-endpoint.mjs");
const STUB_DIGEST = "c".repeat(64);
/** The stub predicts a straight line at this speed; the fixture reference matches it. */
const STUB_SPEED_MPS = 8;
const FIXTURE_ROOT = join(TEST_RUNS_ROOT, "fixtures");

/** Runtime-checked narrowing of the stores' discriminated result unions. */
function expectKind<T extends { kind: string }, K extends T["kind"]>(
  value: T,
  kind: K,
): Extract<T, { kind: K }> {
  if (value.kind !== kind) throw new Error(`expected result kind ${kind}, got ${value.kind}`);
  // Checked one line above; Extract cannot be inferred from the comparison.
  return value as Extract<T, { kind: K }>;
}

/**
 * Build a `simforge.eval-observations/v1` observation bundle on disk.
 *
 * Frames are real 2x2 raw RGB files (12 bytes) rather than fixtures in git:
 * the executor passes their paths to the engine, so their content is the
 * engine's business, but their existence and count are the executor's.
 * `withEgo: false` produces the honest video-only case — frames and
 * calibration but no ego history, which must be refused, not guessed.
 */
async function writeClipBundle(
  name: string,
  options: { cameraIds: readonly number[]; withEgo: boolean; withReference: boolean },
): Promise<string> {
  const directory = join(FIXTURE_ROOT, name);
  const t0Us = 10_000_000;
  const cameras = [];
  for (const cameraId of options.cameraIds) {
    const frames = [];
    for (let index = 0; index < 4; index += 1) {
      const relative = join("frames", String(cameraId), `${index}.raw`);
      await mkdir(join(directory, "frames", String(cameraId)), { recursive: true });
      await writeFile(join(directory, relative), Buffer.alloc(2 * 2 * 3, index + 1));
      frames.push({ tUs: t0Us - (3 - index) * 100_000, path: relative });
    }
    cameras.push({
      cameraId,
      sensorId: `sensor-${cameraId}`,
      encoding: "raw",
      width: 2,
      height: 2,
      frames,
      intrinsics: { model: "pinhole", K: [[1, 0, 1], [0, 1, 1], [0, 0, 1]], coeffs: [] },
      extrinsicsRigFromCamera: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    });
  }
  // 16 poses at 10 Hz ending at t0, straight along +x at the stub's speed.
  const poses = [];
  for (let step = 15; step >= 0; step -= 1) {
    poses.push({
      tUs: t0Us - step * 100_000,
      x: -step * STUB_SPEED_MPS * 0.1,
      y: 0,
      headingRad: 0,
      speedMps: STUB_SPEED_MPS,
    });
  }
  // Reference future in the ego frame at t0: the same straight line, so a
  // correct prediction scores ~0 m ADE and a wrong one cannot hide.
  const referencePoints = [];
  for (let index = 1; index <= 64; index += 1) {
    referencePoints.push([STUB_SPEED_MPS * index * 0.1, 0, 0]);
  }
  await writeFile(
    join(directory, "clip.json"),
    `${JSON.stringify(
      {
        schema: "simforge.eval-observations/v1",
        clipId: name,
        t0Us,
        source: { kind: "user-clip" },
        cameras,
        ego: { poses: options.withEgo ? poses : [] },
        reference: options.withReference
          ? { kind: "dataset", dtS: 0.1, points: referencePoints }
          : { kind: "none", dtS: 0.1, points: [] },
        video: null,
        navText: null,
      },
      null,
      1,
    )}\n`,
    "utf8",
  );
  return directory;
}

function stubEndpointDescriptor(env: Record<string, string>) {
  return CreateModelEndpointSchema.parse({
    modelVersionId: "placeholder",
    name: "placeholder",
    descriptor: {
      kind: "process",
      cmd: ["node", STUB_SCRIPT],
      env,
      health: { kind: "http", path: "/healthz", timeoutMs: 15_000 },
      invoke: { kind: "http-json", path: "/invoke", timeoutMs: 30_000 },
    },
  }).descriptor;
}

let context: AppContext;
let versionId: string;
const controller = new AbortController();
let loop: Promise<void>;

before(async () => {
  context = await bootModelTestDatabase();
  const version = expectKind(await createModelVersion(context, {
    family: "stub",
    name: "Engine Stub",
    source: "local/stub",
    checkpointDigest: STUB_DIGEST,
    quant: "none",
    license: "apache-2.0",
  }), "created");
  versionId = version.version.id;
  loop = runModelRunLoop({
    signal: controller.signal,
    workerId: "loop-test-worker",
    pollMs: 100,
    runsRoot: TEST_RUNS_ROOT,
    kinds: ["openloop"],
  });
}, { timeout: 240_000 });

after(async () => {
  controller.abort(new Error("test complete"));
  await loop;
});

async function waitForTerminal(runId: string, timeoutMs = 60_000) {
  // Integration test against the REAL worker loop, a real PGlite, and a real
  // spawned endpoint process: there is no fake clock that drives all three,
  // so poll the ledger until the run settles.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = (await getModelRun(context, runId))!;
    if (detail.run.status === "succeeded" || detail.run.status === "failed") return detail;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 100);
    await tick.promise;
  }
  throw new Error(`run ${runId} did not settle within ${timeoutMs}ms`);
}

const STUB_ENV = {
  SIMFORGE_STUB_FAMILY: "stub",
  SIMFORGE_STUB_QUANT: "none",
  SIMFORGE_STUB_DIGEST: STUB_DIGEST,
  SIMFORGE_STUB_CAMERAS: "0,1,2,6",
  SIMFORGE_STUB_SPEED: String(STUB_SPEED_MPS),
};

test("openloop run scores against the clip's reference future and writes the shared result manifest", { timeout: 120_000 }, async () => {
  const bundle = await writeClipBundle("scored-clip", { cameraIds: [0, 1, 2, 6], withEgo: true, withReference: true });
  const endpoint = expectKind(await createModelEndpoint(context, {
    modelVersionId: versionId,
    name: "engine-scored",
    descriptor: stubEndpointDescriptor(STUB_ENV),
  }), "created");
  const created = expectKind(await createModelRun(context, CreateModelRunSchema.parse({
    modelVersionId: versionId,
    endpointId: endpoint.endpoint.id,
    kind: "openloop",
    params: {
      items: [{ kind: "user-clip", ref: bundle, cameraProfile: "alpamayo-4cam" }],
      sampling: { numTrajSamples: 1 },
      reference: "auto",
    },
    seed: 42,
  })), "created");

  const detail = await waitForTerminal(created.run.id);
  assert.equal(detail.run.status, "succeeded");
  assert.equal(detail.attempts.length, 1);

  const runDir = join(TEST_RUNS_ROOT, created.run.id);
  const manifest = JSON.parse(await readFile(join(runDir, "result.json"), "utf8")) as {
    schema: string; kind: string; status: string; scored: boolean; promotable: boolean; mode: string;
    metrics: { minADE: Record<string, number>; okItems: number; refusedItems: number };
    artifacts: { role: string; path: string; sha256: string }[];
    provenance: { model: { family: string; quant: string; checkpointDigest: string; determinismScope: string } };
  };
  assert.equal(manifest.schema, "simforge.eval-result-manifest/v1");
  assert.equal(manifest.kind, "openloop");
  assert.equal(manifest.status, "succeeded");
  assert.equal(manifest.mode, "openloop");
  assert.equal(manifest.scored, true);
  assert.equal(manifest.promotable, true);
  assert.equal(manifest.metrics.okItems, 1);
  assert.equal(manifest.metrics.refusedItems, 0);
  // The stub predicts exactly the reference line, so every horizon is ~0 m.
  for (const horizon of ["1", "3", "6.4"]) {
    assert.ok(manifest.metrics.minADE[horizon]! < 1e-6, `minADE@${horizon} = ${String(manifest.metrics.minADE[horizon])}`);
  }
  assert.equal(manifest.provenance.model.family, "stub");
  assert.equal(manifest.provenance.model.checkpointDigest, STUB_DIGEST);
  // A seed is never presented as a cross-device reproducibility claim.
  assert.equal(manifest.provenance.model.determinismScope, "same-host-same-device");
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.role).sort(),
    ["openloop-result", "trajectories"],
  );

  const openloop = JSON.parse(await readFile(join(runDir, "openloop.json"), "utf8")) as {
    schema: string;
    items: { status: string; frame: string; convention: string; dtS: number; points: number[][][]; reference: { kind: string }; projection: unknown }[];
    aggregate: { scoredItems: Record<string, number> };
  };
  assert.equal(openloop.schema, "simforge.openloop-result/v1");
  assert.equal(openloop.items.length, 1);
  assert.equal(openloop.items[0]!.status, "ok");
  assert.equal(openloop.items[0]!.frame, "ego@t0");
  assert.equal(openloop.items[0]!.convention, "FLU");
  assert.equal(openloop.items[0]!.dtS, 0.1);
  assert.equal(openloop.items[0]!.points[0]!.length, 64);
  assert.equal(openloop.items[0]!.reference.kind, "dataset");
  assert.notEqual(openloop.items[0]!.projection, null);
  assert.equal(openloop.aggregate.scoredItems["6.4"], 1);
});

test("a clip without ego history is refused with the exact missing field and is never scored", { timeout: 120_000 }, async () => {
  const bundle = await writeClipBundle("video-only-clip", { cameraIds: [0, 1, 2, 6], withEgo: false, withReference: false });
  const endpoint = expectKind(await createModelEndpoint(context, {
    modelVersionId: versionId,
    name: "engine-refusal",
    descriptor: stubEndpointDescriptor(STUB_ENV),
  }), "created");
  const created = expectKind(await createModelRun(context, CreateModelRunSchema.parse({
    modelVersionId: versionId,
    endpointId: endpoint.endpoint.id,
    kind: "openloop",
    params: { items: [{ kind: "user-clip", ref: bundle }] },
  })), "created");

  const detail = await waitForTerminal(created.run.id);
  assert.equal(detail.run.status, "succeeded");

  const runDir = join(TEST_RUNS_ROOT, created.run.id);
  const manifest = JSON.parse(await readFile(join(runDir, "result.json"), "utf8")) as {
    status: string; scored: boolean; promotable: boolean; metrics: { refusedItems: number; minADE: Record<string, number> };
  };
  // Evidence of a refusal is a partial result, not a success and not a score.
  assert.equal(manifest.status, "partial");
  assert.equal(manifest.scored, false);
  assert.equal(manifest.promotable, false);
  assert.equal(manifest.metrics.refusedItems, 1);
  assert.deepEqual(manifest.metrics.minADE, {});

  const openloop = JSON.parse(await readFile(join(runDir, "openloop.json"), "utf8")) as {
    items: { status: string; points: number[][][]; refusal: { code: string; missingFields: string[]; message: string } }[];
  };
  assert.equal(openloop.items[0]!.status, "refused");
  assert.equal(openloop.items[0]!.refusal.code, "missing_fields");
  assert.deepEqual(openloop.items[0]!.refusal.missingFields, ["ego.poses"]);
  // Nothing was fabricated to make the run "work".
  assert.deepEqual(openloop.items[0]!.points, []);
  assert.match(openloop.items[0]!.refusal.message, /ego history/);
});

test("an engine reporting a different checkpoint fails the run instead of attributing results to it", { timeout: 120_000 }, async () => {
  const bundle = await writeClipBundle("identity-clip", { cameraIds: [0, 1, 2, 6], withEgo: true, withReference: true });
  const endpoint = expectKind(await createModelEndpoint(context, {
    modelVersionId: versionId,
    name: "engine-wrong-checkpoint",
    descriptor: stubEndpointDescriptor({ ...STUB_ENV, SIMFORGE_STUB_DIGEST: "d".repeat(64) }),
  }), "created");
  const created = expectKind(await createModelRun(context, CreateModelRunSchema.parse({
    modelVersionId: versionId,
    endpointId: endpoint.endpoint.id,
    kind: "openloop",
    params: { items: [{ kind: "user-clip", ref: bundle }] },
    maxAttempts: 1,
  })), "created");

  const detail = await waitForTerminal(created.run.id);
  assert.equal(detail.run.status, "failed");
  assert.equal(detail.attempts.at(-1)!.errorCode, "model_revision_mismatch");
});

test("crashing endpoint burns every attempt and fails the run terminally", { timeout: 120_000 }, async () => {
  const bundle = await writeClipBundle("crash-clip", { cameraIds: [0, 1, 2, 6], withEgo: true, withReference: true });
  const endpoint = expectKind(await createModelEndpoint(context, {
    modelVersionId: versionId,
    name: "crash",
    descriptor: CreateModelEndpointSchema.parse({
      modelVersionId: "placeholder",
      name: "placeholder",
      descriptor: {
        kind: "process",
        cmd: ["node", "/nonexistent/simforge-endpoint.mjs"],
        health: { kind: "http", path: "/healthz", timeoutMs: 5_000 },
        invoke: { kind: "http-json", path: "/invoke", timeoutMs: 5_000 },
      },
    }).descriptor,
  }), "created");
  const created = expectKind(await createModelRun(context, CreateModelRunSchema.parse({
    modelVersionId: versionId,
    endpointId: endpoint.endpoint.id,
    kind: "openloop",
    params: { items: [{ kind: "user-clip", ref: bundle }] },
    maxAttempts: 2,
  })), "created");

  const detail = await waitForTerminal(created.run.id);
  assert.equal(detail.run.status, "failed");
  assert.equal(detail.attempts.length, 2);
  assert.deepEqual(detail.attempts.map((attempt) => attempt.state), ["failed", "failed"]);
  assert.equal(detail.attempts[1]!.errorCode, "endpoint_exited");
  assert.deepEqual(
    detail.events.map((event) => event.eventType),
    ["run.queued", "attempt.started", "attempt.failed", "attempt.started", "run.failed"],
  );
});
