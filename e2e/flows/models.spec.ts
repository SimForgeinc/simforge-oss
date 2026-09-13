import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import {
  createE2eContext,
  definePrerequisite,
  expect,
  FIXTURES_DIR,
  launchBrowserStudio,
  prerequisiteStatus,
  PREREQUISITES,
  requirePrerequisites,
  STUDIO_ROOT,
  test,
  writeEvidence,
  type E2eContext,
} from "../support/index";

/**
 * Model management and model evaluation, end to end.
 *
 * Two lanes, kept apart on purpose:
 *
 * **Stub lane** (always runs). A deterministic fixture engine
 * (`studio/worker/testing/echo-endpoint.mjs`) stands in for a checkpoint. It
 * echoes a straight line and reports a fixed checkpoint digest, so it can
 * prove the *contracts* — the run ledger, checkpoint identity, the refusal
 * codes, the unscored labelling, restart survival, the result documents — and
 * it is never used to claim accuracy, because a stub has none. The model store
 * is exercised in this lane only where no bytes move: catalog, preflight,
 * pre-transfer refusals, and verify/remove verdicts on an absent install.
 * Every store mutation runs against a throwaway `SIMFORGE_ASSETS_ROOT` with
 * `HF_ENDPOINT` pointed at a closed loopback port, so a regression that tried
 * to fetch weights fails instead of downloading 22 GB onto the runner.
 *
 * **Staging lane** (prerequisite-gated, never silently skipped). Real weights
 * on disk, and the cloud open-loop upload flow for Alpamayo 1.5 / 2 Super.
 * When the inputs are absent, `requirePrerequisites` writes a machine-readable
 * `prerequisite-missing` evidence document, annotates the test and fails it.
 *
 * Out of scope by assignment: closed-loop frontend behaviour and the
 * scenario-generation UI.
 */

const require = createRequire(import.meta.url);

type ClipSpec = {
  clipId: string;
  cameraIds: number[];
  withEgo: boolean;
  withReference: boolean;
  deleteFrame?: { cameraId: number; index: number };
  /** Documents why a refusal code is what it is; not read by the suite. */
  note?: string;
  expect: {
    itemStatus: string;
    refusalCode?: string;
    missingFields?: string[];
    scored: boolean;
    manifestStatus: string;
  };
};

type Fixture = {
  engine: {
    family: string;
    displayName: string;
    quant: string;
    license: string;
    source: string;
    checkpointDigest: string;
    wrongCheckpointDigest: string;
    requiredCameras: number[];
    cameraProfile: string;
    speedMps: number;
    waypoints: number;
    dtS: number;
  };
  clips: Record<string, ClipSpec>;
  catalog: {
    families: string[];
    stagingFamilies: string[];
    weightsLicenseId: string;
    weightsLicenseBlobSha: string;
    gatedSidecarRepo: string;
    gatedSidecarFamily: string;
    viewSchema: string;
  };
};

const FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "models", "fixture-engine.json"), "utf8"),
) as Fixture;

const STUB_ENDPOINT_SCRIPT = join(STUDIO_ROOT, "worker", "testing", "echo-endpoint.mjs");
const MODEL_RUN_WORKER_SCRIPT = join(STUDIO_ROOT, "scripts", "model-run-worker.ts");

/** Weights already installed on this machine, for the real store lifecycle. */
const INSTALLED_WEIGHTS = definePrerequisite({
  id: "installed-model-weights",
  title: "A real Alpamayo install under a disposable assets root",
  env: ["SIMFORGE_E2E_MODEL_ASSETS_ROOT", "SIMFORGE_E2E_MODEL_FAMILY"],
  hint:
    "install a family with the Models screen, then point SIMFORGE_E2E_MODEL_ASSETS_ROOT at that "
    + "assets root (the directory holding models/ and hf-cache/) and SIMFORGE_E2E_MODEL_FAMILY at "
    + "the installed family id. The lane re-verifies digests; it removes and re-starts the install "
    + "only when SIMFORGE_E2E_MODEL_DESTRUCTIVE=1.",
  verify: (values) => {
    const root = values.SIMFORGE_E2E_MODEL_ASSETS_ROOT ?? "";
    if (!existsSync(join(root, "models"))) return `${root} has no models/ directory`;
    const family = values.SIMFORGE_E2E_MODEL_FAMILY ?? "";
    return FIXTURE.catalog.families.includes(family)
      ? null
      : `SIMFORGE_E2E_MODEL_FAMILY must be one of ${FIXTURE.catalog.families.join(", ")}`;
  },
});

/** Removing and restarting a real install destroys tens of gigabytes; opt in. */
const DESTRUCTIVE_WEIGHTS = definePrerequisite({
  id: "destructive-weights",
  title: "Permission to remove and re-start a real install",
  env: ["SIMFORGE_E2E_MODEL_DESTRUCTIVE"],
  hint: "set SIMFORGE_E2E_MODEL_DESTRUCTIVE=1 only where re-downloading the weights is acceptable",
  verify: (values) =>
    values.SIMFORGE_E2E_MODEL_DESTRUCTIVE === "1" ? null : "must be exactly \"1\"",
});

/** A real driving video for the uploaded-video staging flow. */
const VIDEO_FIXTURE = definePrerequisite({
  id: "driving-video",
  title: "A real driving video file for the upload flow",
  env: ["SIMFORGE_E2E_DRIVING_VIDEO"],
  hint:
    "point SIMFORGE_E2E_DRIVING_VIDEO at a short front-camera clip the browser can decode; "
    + "no synthetic file is substituted, because the launcher probes duration and dimensions",
  verify: (values) =>
    existsSync(values.SIMFORGE_E2E_DRIVING_VIDEO ?? "")
      ? null
      : "the configured video path does not exist",
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

type StudioLike = {
  page: Page;
  goto(path: string): Promise<unknown>;
  close(): Promise<void>;
};

type ApiResult<T> = { status: number; body: T };

/**
 * Call a studio route from inside the page.
 *
 * Deliberately not a Node-side request: the mutation routes require a
 * same-origin `Origin` header and the trusted session cookie, and asking the
 * browser to issue the request is how a test exercises the same path the UI
 * does — including the status codes, which a throwing client would hide.
 */
async function api<T>(
  studio: StudioLike,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const payload = init.body === undefined ? null : JSON.stringify(init.body);
  return (await studio.page.evaluate(
    async ([route, method, body]) => {
      const response = await fetch(route as string, {
        method: (method as string) ?? "GET",
        cache: "no-store",
        headers:
          body === null
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
        body: body === null ? undefined : (body as string),
      });
      const text = await response.text();
      return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
    },
    [path, init.method ?? "GET", payload] as const,
  )) as ApiResult<T>;
}

async function ok<T>(studio: StudioLike, path: string, init: { method?: string; body?: unknown } = {}) {
  const result = await api<T>(studio, path, init);
  expect(result.status, `${init.method ?? "GET"} ${path} → ${JSON.stringify(result.body)}`).toBeLessThan(300);
  return result.body;
}

/**
 * A studio host with its own model assets root and no route to Hugging Face.
 *
 * `HF_ENDPOINT` points at a port nothing listens on: the stub lane asserts
 * that no transfer is even attempted, and if one were attempted it must fail
 * loudly rather than quietly pull weights onto the machine running the suite.
 */
async function isolatedStudio(
  e2e: E2eContext,
  extraEnv: Record<string, string> = {},
): Promise<StudioLike & { assetsRoot: string }> {
  const assetsRoot = join(e2e.dataRoot, "model-assets");
  await mkdir(assetsRoot, { recursive: true });
  const session = await launchBrowserStudio(e2e, {
    env: {
      SIMFORGE_ASSETS_ROOT: assetsRoot,
      HF_ENDPOINT: "http://127.0.0.1:9",
      ...extraEnv,
    },
  });
  await session.api("/api/simforge/host/setup", {
    method: "PUT",
    body: JSON.stringify({ mode: "local", quality: "roads-only" }),
  });
  return Object.assign(session, { assetsRoot });
}

/**
 * Write a `simforge.eval-observations/v1` bundle.
 *
 * Frames are 2x2 raw RGB files rather than committed fixtures: the executor
 * only passes their paths to the engine, so their content is the engine's
 * business while their existence and count are the executor's — which is
 * exactly what `brokenFrames` removes to produce a real `input_error`.
 */
async function writeClipBundle(root: string, spec: ClipSpec): Promise<string> {
  const directory = join(root, spec.clipId);
  const t0Us = 10_000_000;
  const speed = FIXTURE.engine.speedMps;
  const cameras = [];
  for (const cameraId of spec.cameraIds) {
    const frames = [];
    await mkdir(join(directory, "frames", String(cameraId)), { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      const relative = join("frames", String(cameraId), `${index}.raw`);
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
  // 16 poses at 10 Hz ending at t0, straight along +x at the fixture speed.
  const poses = [];
  for (let step = 15; step >= 0; step -= 1) {
    poses.push({ tUs: t0Us - step * 100_000, x: -step * speed * 0.1, y: 0, headingRad: 0, speedMps: speed });
  }
  // The reference future is the same straight line, so the fixture engine's
  // prediction lands on it. That is a contract check on the scoring path, not
  // a statement about model quality.
  const referencePoints = [];
  for (let index = 1; index <= FIXTURE.engine.waypoints; index += 1) {
    referencePoints.push([speed * index * FIXTURE.engine.dtS, 0, 0]);
  }
  await writeFile(
    join(directory, "clip.json"),
    `${JSON.stringify(
      {
        schema: "simforge.eval-observations/v1",
        clipId: spec.clipId,
        t0Us,
        source: { kind: "user-clip" },
        cameras,
        ego: { poses: spec.withEgo ? poses : [] },
        reference: spec.withReference
          ? { kind: "dataset", dtS: FIXTURE.engine.dtS, points: referencePoints }
          : { kind: "none", dtS: FIXTURE.engine.dtS, points: [] },
        video: null,
        navText: null,
      },
      null,
      1,
    )}\n`,
    "utf8",
  );
  if (spec.deleteFrame) {
    await rm(
      join(directory, "frames", String(spec.deleteFrame.cameraId), `${spec.deleteFrame.index}.raw`),
      { force: true },
    );
  }
  return directory;
}

function stubEngineEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SIMFORGE_STUB_FAMILY: FIXTURE.engine.family,
    SIMFORGE_STUB_QUANT: FIXTURE.engine.quant,
    SIMFORGE_STUB_DIGEST: FIXTURE.engine.checkpointDigest,
    SIMFORGE_STUB_CAMERAS: FIXTURE.engine.requiredCameras.join(","),
    SIMFORGE_STUB_SPEED: String(FIXTURE.engine.speedMps),
    SIMFORGE_STUB_WAYPOINTS: String(FIXTURE.engine.waypoints),
    SIMFORGE_STUB_PROFILE: FIXTURE.engine.cameraProfile,
    ...overrides,
  };
}

function stubDescriptor(env: Record<string, string>) {
  return {
    kind: "process" as const,
    cmd: ["node", STUB_ENDPOINT_SCRIPT],
    env,
    health: { kind: "http" as const, path: "/healthz", timeoutMs: 30_000 },
    invoke: { kind: "http-json" as const, path: "/invoke", timeoutMs: 60_000 },
  };
}

/**
 * Drain the queued runs with the real model-run worker, with the app closed.
 *
 * The desktop database is a single-writer PGlite owned by whichever process
 * holds the data root, so the worker cannot share it with a running server.
 * Running it between two app sessions is not a workaround: it is the honest
 * shape of "the queue is durable" — the runs are submitted by one app session,
 * executed while nothing is open, and read back by the next session.
 */
async function drainModelRuns(
  e2e: E2eContext,
  runIds: readonly string[],
  timeoutMs = 300_000,
): Promise<Record<string, { event: string; code?: string; runStatus?: string }>> {
  const pending = new Set(runIds);
  const terminal: Record<string, { event: string; code?: string; runStatus?: string }> = {};
  const child = spawn(process.execPath, [require.resolve("tsx/cli"), MODEL_RUN_WORKER_SCRIPT], {
    cwd: STUDIO_ROOT,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...e2e.env, SIMFORGE_RUNS_ROOT: e2e.runsRoot },
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      clearTimeout(kill);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the model-run worker did not settle ${[...pending].join(", ")} within ${timeoutMs}ms`)),
        timeoutMs,
      );
      let buffered = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim().startsWith("{")) continue;
          let event: { event?: string; runId?: string; code?: string; runStatus?: string };
          try {
            event = JSON.parse(line) as typeof event;
          } catch {
            continue;
          }
          const runId = event.runId;
          if (!runId || !pending.has(runId)) continue;
          const settled =
            event.event === "run.succeeded"
              ? { event: "run.succeeded" }
              : event.event === "attempt.failed" && event.runStatus === "failed"
                ? { event: "attempt.failed", code: event.code, runStatus: event.runStatus }
                : null;
          if (!settled) continue;
          terminal[runId] = settled;
          pending.delete(runId);
          if (pending.size === 0) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the model-run worker exited (code ${String(code)}) with ${pending.size} run(s) pending`));
      });
    });
  } finally {
    await stop();
  }
  return terminal;
}

async function readRunDocument<T>(e2e: E2eContext, runId: string, name: string): Promise<T> {
  return JSON.parse(await readFile(join(e2e.runsRoot, runId, name), "utf8")) as T;
}

/* -------------------------------------------------------------------------- */
/* stub lane — the model store, with no bytes in motion                       */
/* -------------------------------------------------------------------------- */

type StoreCatalogEntry = {
  family: string;
  displayName: string;
  weightsRepo: string;
  weightsRevision: string;
  requiresUserHfToken: boolean;
  remoteOnly: boolean;
  license: { id: string; blobSha: string; commercialUseReviewRequired: boolean; cardConflictNote: string | null };
  quants: { quant: string; status: string; minVramGiB: number | null; note: string }[];
  cameras: { required: number[] | null; variable: boolean; default: number[]; max: number };
};

type StoreView = {
  schema: string;
  catalog: StoreCatalogEntry[];
  installs: { family: string; quant: string | null; state: { state: string } }[];
  eligibility: {
    family: string;
    quant: string;
    downloadEligible: boolean;
    downloadBlockedReasons: string[];
    executionEligible: boolean;
    qualification: string;
    reasons: string[];
  }[];
  reviewGates: { family: string; kind: string; resolved: boolean; note: string }[];
  vault: { persistence: string; hfTokenPresent: boolean; hfTokenIdentity: string | null };
};

function catalogEntry(view: StoreView, family: string): StoreCatalogEntry {
  const entry = view.catalog.find((candidate) => candidate.family === family);
  if (entry === undefined) throw new Error(`Model catalog omitted ${family}`);
  return entry;
}

test.describe("model store — catalogue and preflight (fixture lane, no weights)", () => {
  test("the catalogue states family, quantization, revision and licence gates per model", async ({ e2e }, testInfo) => {
    test.setTimeout(420_000);
    const studio = await isolatedStudio(e2e);
    try {
      const view = await ok<StoreView>(studio, "/api/models/store");
      expect(view.schema).toBe(FIXTURE.catalog.viewSchema);
      expect(view.catalog.map((entry) => entry.family).sort()).toEqual([...FIXTURE.catalog.families].sort());

      for (const family of FIXTURE.catalog.families) {
        const entry = catalogEntry(view, family);
        expect(entry.family).toBe(family);
        // A pinned revision is what makes an install identifiable at all.
        expect(entry.weightsRevision).toMatch(/^[0-9a-f]{40}$/);
        expect(entry.license.id).toBe(FIXTURE.catalog.weightsLicenseId);
        expect(entry.license.blobSha).toBe(FIXTURE.catalog.weightsLicenseBlobSha);
        expect(entry.quants.length).toBeGreaterThan(0);
        for (const offer of entry.quants) {
          expect(["supported", "qualification-pending", "unsupported"]).toContain(offer.status);
          // A quant may only advertise a VRAM envelope once it is measured.
          if (offer.status !== "supported") expect(offer.minVramGiB).toBeNull();
          expect(offer.note.length).toBeGreaterThan(0);
        }
      }

      // The gated sidecar and the card/licence conflict are unresolved
      // obligations, and no document may claim either is closed.
      const gates = view.reviewGates;
      expect(gates.length).toBeGreaterThan(0);
      expect(gates.every((gate) => gate.resolved === false)).toBe(true);
      expect(gates.some((gate) => gate.kind === "gated-sidecar" && gate.family === FIXTURE.catalog.gatedSidecarFamily)).toBe(true);
      expect(gates.some((gate) => gate.kind === "license-conflict")).toBe(true);
      expect(catalogEntry(view, FIXTURE.catalog.gatedSidecarFamily).requiresUserHfToken).toBe(true);

      // Download eligibility and execution eligibility are separate verdicts:
      // a machine may hold weights it cannot run, and the store must say so
      // with reasons rather than collapsing both into one boolean.
      expect(view.eligibility.length).toBeGreaterThan(0);
      for (const entry of view.eligibility) {
        expect(["qualified", "qualification-pending", "unsupported"]).toContain(entry.qualification);
        if (!entry.executionEligible) expect(entry.reasons.length).toBeGreaterThan(0);
        if (!entry.downloadEligible) expect(entry.downloadBlockedReasons.length).toBeGreaterThan(0);
      }

      const preflight = await ok<{ schema: string }>(studio, "/api/models/store/preflight");
      expect(preflight.schema).toContain("model-preflight");
      const unknown = await api(studio, "/api/models/store/preflight?family=not-a-model");
      expect(unknown.status).toBe(400);

      // The screen the user actually reads.
      await studio.goto("/dashboard/models");
      await expect(studio.page.getByTestId("model-store-panel")).toBeVisible({ timeout: 60_000 });
      for (const family of FIXTURE.catalog.families) {
        await expect(studio.page.getByTestId(`model-card-${family}`)).toBeVisible();
        for (const offer of catalogEntry(view, family).quants) {
          await expect(studio.page.getByTestId(`quant-row-${family}-${offer.quant}`)).toBeVisible();
        }
      }
      await expect(studio.page.getByTestId("refusal-notice").first()).toContainText("Unresolved obligations");

      await writeEvidence(testInfo, "model-catalog", {
        outcome: "verified",
        lane: "fixture",
        accuracyClaimed: false,
        viewSchema: view.schema,
        families: FIXTURE.catalog.families.map((family) => {
          const entry = catalogEntry(view, family);
          return {
            family,
            weightsRepo: entry.weightsRepo,
            weightsRevision: entry.weightsRevision,
            quantizations: entry.quants.map((offer) => ({ quant: offer.quant, status: offer.status, minVramGiB: offer.minVramGiB })),
            license: entry.license.id,
            requiresUserHfToken: entry.requiresUserHfToken,
            remoteOnly: entry.remoteOnly,
            cameras: entry.cameras,
          };
        }),
        reviewGates: gates,
      });
    } finally {
      await studio.close();
    }
  });

  test("install refuses before any bytes move, and verify/remove are honest about an absent install", async ({ e2e }, testInfo) => {
    test.setTimeout(420_000);
    const studio = await isolatedStudio(e2e);
    const family = "alpamayo-1";
    try {
      await studio.goto("/dashboard/models");
      await expect(studio.page.getByTestId("model-store-panel")).toBeVisible({ timeout: 60_000 });

      const view = await ok<StoreView>(studio, "/api/models/store");
      const quant = catalogEntry(view, family).quants.find((offer) => offer.status === "supported")!.quant;
      expect(view.installs.every((row) => row.state.state === "not_installed")).toBe(true);

      // 1. No licence acceptance, no transfer.
      const unaccepted = await api<{ error: string }>(studio, "/api/models/store/install", {
        method: "POST",
        body: { family, quant },
      });
      expect(unaccepted.status).toBe(400);
      expect(["invalid_install_request", "license_acceptance_required"]).toContain(unaccepted.body.error);

      // 2. The gated sidecar needs a token *before* the first byte. Only
      //    assertable when this machine's vault does not already hold one;
      //    when it does, the catalogue-level gate above is the coverage and
      //    the evidence says which branch ran rather than pretending.
      const gatedFamily = FIXTURE.catalog.gatedSidecarFamily;
      const gatedQuant = catalogEntry(view, gatedFamily).quants.find((offer) => offer.status === "supported")!.quant;
      let tokenRefusal: unknown = { branch: "skipped", reason: "a Hugging Face token is already in this machine's vault" };
      if (!view.vault.hfTokenPresent) {
        const gated = await api<{ error: string; detail?: { repo?: string; acceptUrl?: string } }>(
          studio,
          "/api/models/store/install",
          { method: "POST", body: { family: gatedFamily, quant: gatedQuant, acceptLicense: true, acceptSidecarLicense: true } },
        );
        expect(gated.status).toBe(400);
        expect(gated.body.error).toBe("hf_token_required");
        expect(gated.body.detail?.repo).toBe(FIXTURE.catalog.gatedSidecarRepo);
        tokenRefusal = { branch: "refused", error: gated.body.error, detail: gated.body.detail };
      }

      // 3. Verify on an absent install reports every file missing — and still
      //    names the checkpoint digest the lock pins, because identity comes
      //    from the lock, not from whatever happens to be on disk.
      const verify = await ok<{
        family: string;
        deep: boolean;
        ok: boolean;
        checkpointDigest: string;
        verified: { path: string }[];
        failed: { path: string; reason: string | null }[];
      }>(studio, "/api/models/store/verify", { method: "POST", body: { family, deep: false } });
      expect(verify.ok).toBe(false);
      expect(verify.verified).toHaveLength(0);
      expect(verify.failed.length).toBeGreaterThan(0);
      expect(verify.failed.every((verdict) => verdict.reason === "missing")).toBe(true);
      expect(verify.checkpointDigest).toMatch(/^[0-9a-f]{64}$/);

      // 4. Remove is a no-op that says so, rather than reporting freed space.
      const removed = await ok<{ freedBytes: number; removed: unknown; state: { state: string } }>(
        studio,
        `/api/models/store/${family}?quant=${quant}&purgeSharedCache=false`,
        { method: "DELETE" },
      );
      expect(removed.freedBytes).toBe(0);
      expect(removed.state.state).toBe("not_installed");

      // 5. Cancelling nothing leaves nothing behind.
      const cancelled = await ok<{ state: { state: string } }>(studio, "/api/models/store/install/cancel", {
        method: "POST",
        body: { family, discardPartials: true },
      });
      expect(cancelled.state.state).toBe("not_installed");

      // 6. A dry-run reclaim is the default posture and frees nothing.
      const reclaim = await ok<{ dryRun: boolean; freedBytes: number; reclaimableBytes: number }>(
        studio,
        "/api/models/store/cache/reclaim",
        { method: "POST", body: { dryRun: true } },
      );
      expect(reclaim.dryRun).toBe(true);
      expect(reclaim.freedBytes).toBe(0);

      // Nothing was downloaded: the disposable assets root holds no install.
      expect(existsSync(join(studio.assetsRoot, "models", family))).toBe(false);

      const after = await ok<StoreView>(studio, "/api/models/store");
      expect(after.installs.every((row) => row.state.state === "not_installed")).toBe(true);

      await writeEvidence(testInfo, "model-install-refusals", {
        outcome: "verified",
        lane: "fixture",
        accuracyClaimed: false,
        bytesTransferred: 0,
        family,
        quantization: quant,
        checkpointDigest: verify.checkpointDigest,
        weightsRevision: catalogEntry(view, family).weightsRevision,
        refusals: {
          licenseAcceptance: unaccepted.body.error,
          gatedSidecarToken: tokenRefusal,
          verifyAbsentInstall: { ok: verify.ok, failedFiles: verify.failed.length, allMissing: true },
          removeAbsentInstall: { freedBytes: removed.freedBytes, state: removed.state.state },
        },
      });
    } finally {
      await studio.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* stub lane — runs: identity, refusals, restart survival, result documents   */
/* -------------------------------------------------------------------------- */

type ModelRunRow = {
  id: string;
  kind: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  metrics: Record<string, unknown> | null;
  outputRefs: unknown[];
};

type RunDetail = {
  run: ModelRunRow;
  attempts: { attemptNumber: number; state: string; errorCode: string | null }[];
  events: { eventType: string }[];
};

type ResultManifest = {
  schema: string;
  kind: string;
  mode: string;
  status: string;
  scored: boolean;
  promotable: boolean;
  metrics: { minADE?: Record<string, number>; okItems: number; refusedItems: number };
  artifacts: { role: string; path: string; sha256: string }[];
  provenance: { model: { family: string; quant: string; checkpointDigest: string; determinismScope: string } };
};

type OpenLoopResult = {
  schema: string;
  items: {
    status: string;
    frame?: string;
    convention?: string;
    dtS?: number;
    points: number[][][];
    reference?: { kind: string };
    projection: unknown;
    refusal?: { code: string; missingFields: string[]; message: string; requiredCameras: number[] | null };
  }[];
  aggregate: { scoredItems: Record<string, number> };
};

test.describe("model evaluation — fixture engine lane (contracts only, no accuracy)", () => {
  test("open-loop runs survive a restart and record identity, refusals and unscored labelling", async ({ e2e }, testInfo) => {
    // Two full app boots plus a worker drain of five runs.
    test.setTimeout(1_500_000);

    const bundleRoot = join(e2e.dataRoot, "clips");
    await mkdir(bundleRoot, { recursive: true });
    const clips = FIXTURE.clips;
    const bundles: Record<string, string> = {};
    for (const [name, spec] of Object.entries(clips)) {
      bundles[name] = await writeClipBundle(bundleRoot, spec);
    }

    const submitted: Record<string, string> = {};
    let versionId = "";

    const first = await isolatedStudio(e2e);
    try {
      await first.goto("/dashboard/evaluation");

      // The fixture engine is registered as its own family, never as an
      // Alpamayo version: a stub must not be able to masquerade as a
      // checkpoint anywhere a result is attributed.
      const version = await ok<{ id: string; family: string; quant: string; checkpointDigest: string }>(
        first,
        "/api/models/versions",
        {
          method: "POST",
          body: {
            family: FIXTURE.engine.family,
            name: FIXTURE.engine.displayName,
            source: FIXTURE.engine.source,
            checkpointDigest: FIXTURE.engine.checkpointDigest,
            quant: FIXTURE.engine.quant,
            license: FIXTURE.engine.license,
          },
        },
      );
      versionId = version.id;
      expect(version.family).toBe(FIXTURE.engine.family);
      expect(version.checkpointDigest).toBe(FIXTURE.engine.checkpointDigest);

      const endpointFor = async (name: string, env: Record<string, string>) =>
        (await ok<{ id: string }>(first, "/api/models/endpoints", {
          method: "POST",
          body: { modelVersionId: versionId, name, descriptor: stubDescriptor(env) },
        })).id;

      const matching = await endpointFor("e2e-fixture-matching", stubEngineEnv());
      const mismatched = await endpointFor(
        "e2e-fixture-wrong-checkpoint",
        stubEngineEnv({ SIMFORGE_STUB_DIGEST: FIXTURE.engine.wrongCheckpointDigest }),
      );

      const submit = async (
        key: string,
        bundle: string,
        endpointId: string,
        params: Record<string, unknown>,
        maxAttempts = 1,
      ) => {
        const run = await ok<{ id: string; status: string }>(first, "/api/models/runs", {
          method: "POST",
          body: {
            modelVersionId: versionId,
            endpointId,
            kind: "openloop",
            seed: 42,
            maxAttempts,
            params: {
              items: [{ kind: "user-clip", ref: bundles[bundle], cameraProfile: FIXTURE.engine.cameraProfile }],
              sampling: { numTrajSamples: 1 },
              ...params,
            },
          },
        });
        // Submission is durable immediately; execution is the worker's job.
        expect(run.status).toBe("queued");
        submitted[key] = run.id;
        return run.id;
      };

      await submit("scored", "scored", matching, { reference: "auto" });
      await submit("videoOnly", "videoOnly", matching, { reference: "auto" });
      await submit("missingCameras", "missingCameras", matching, { reference: "auto" });
      await submit("brokenFrames", "brokenFrames", matching, { reference: "auto" });
      // The same valid clip against an engine that reports a different
      // checkpoint: the run must fail on identity, not produce a result.
      await submit("identity", "scored", mismatched, { reference: "auto" });

      // An unrunnable run is refused at submission rather than queued: a
      // trajectory run with no items cannot be executed by anyone.
      const invalid = await api<{ error: string }>(first, "/api/models/runs", {
        method: "POST",
        body: { modelVersionId: versionId, endpointId: matching, kind: "openloop", params: { items: [] } },
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe("invalid_model_run");

      const queued = await ok<{ runs: ModelRunRow[] }>(first, "/api/models/runs?status=queued");
      expect(queued.runs).toHaveLength(5);
    } finally {
      // Close the app: the queue must outlive the session that created it.
      await first.close();
    }

    const runIds = [...new Set(Object.values(submitted))];
    const terminal = await drainModelRuns(e2e, runIds);

    const second = await isolatedStudio(e2e);
    try {
      // 1. Restart survival: every run submitted by the previous session is
      //    still in the ledger, with the outcome the worker reached while no
      //    app was open.
      const scored = await ok<RunDetail>(second, `/api/models/runs/${submitted.scored!}`);
      expect(scored.run.status).toBe("succeeded");
      expect(scored.attempts).toHaveLength(1);
      expect(scored.events.map((event) => event.eventType)).toContain("run.queued");

      const scoredManifest = await readRunDocument<ResultManifest>(e2e, submitted.scored!, "result.json");
      expect(scoredManifest.schema).toBe("simforge.eval-result-manifest/v1");
      expect(scoredManifest.kind).toBe("openloop");
      expect(scoredManifest.mode).toBe("openloop");
      expect(scoredManifest.status).toBe("succeeded");
      expect(scoredManifest.scored).toBe(true);
      expect(scoredManifest.metrics.okItems).toBe(1);
      expect(scoredManifest.metrics.refusedItems).toBe(0);
      // Identity, quantization and the scope a seed actually buys.
      expect(scoredManifest.provenance.model.family).toBe(FIXTURE.engine.family);
      expect(scoredManifest.provenance.model.quant).toBe(FIXTURE.engine.quant);
      expect(scoredManifest.provenance.model.checkpointDigest).toBe(FIXTURE.engine.checkpointDigest);
      expect(scoredManifest.provenance.model.determinismScope).toBe("same-host-same-device");
      expect(scoredManifest.artifacts.map((artifact) => artifact.role).sort()).toEqual(["openloop-result", "trajectories"]);

      // 2. The trajectory the overlay draws, and the projection that makes
      //    drawing it legitimate at all.
      const openloop = await readRunDocument<OpenLoopResult>(e2e, submitted.scored!, "openloop.json");
      expect(openloop.schema).toBe("simforge.openloop-result/v1");
      expect(openloop.items).toHaveLength(1);
      expect(openloop.items[0]!.status).toBe("ok");
      expect(openloop.items[0]!.frame).toBe("ego@t0");
      expect(openloop.items[0]!.convention).toBe("FLU");
      expect(openloop.items[0]!.dtS).toBe(FIXTURE.engine.dtS);
      expect(openloop.items[0]!.points[0]).toHaveLength(FIXTURE.engine.waypoints);
      expect(openloop.items[0]!.projection).not.toBeNull();
      expect(openloop.aggregate.scoredItems["6.4"]).toBe(1);

      // 3. Refusals: an unscoreable or invalid input is a labelled partial
      //    result with no trajectory, never a success and never a score.
      const refusals: Record<string, { code: string; missingFields: string[]; requiredCameras: number[] | null; manifestStatus: string }> = {};
      for (const label of ["videoOnly", "missingCameras", "brokenFrames"] as const) {
        const spec = FIXTURE.clips[label]!;
        const runId = submitted[label]!;
        const detail = await ok<RunDetail>(second, `/api/models/runs/${runId}`);
        expect(detail.run.status, `${label} run status`).toBe("succeeded");

        const manifest = await readRunDocument<ResultManifest>(e2e, runId, "result.json");
        expect(manifest.status, `${label} manifest status`).toBe(spec.expect.manifestStatus);
        expect(manifest.scored, `${label} scored`).toBe(false);
        expect(manifest.promotable, `${label} promotable`).toBe(false);
        expect(manifest.metrics.refusedItems).toBe(1);
        expect(manifest.metrics.minADE ?? {}).toEqual({});

        const result = await readRunDocument<OpenLoopResult>(e2e, runId, "openloop.json");
        const item = result.items[0]!;
        expect(item.status, `${label} item status`).toBe(spec.expect.itemStatus);
        expect(item.refusal?.code, `${label} refusal code`).toBe(spec.expect.refusalCode);
        if (spec.expect.missingFields) {
          expect(item.refusal?.missingFields).toEqual(spec.expect.missingFields);
        }
        // Nothing is fabricated to make a refused item look like a result.
        expect(item.points).toEqual([]);
        refusals[label] = {
          code: item.refusal!.code,
          missingFields: item.refusal!.missingFields,
          requiredCameras: item.refusal!.requiredCameras ?? null,
          manifestStatus: manifest.status,
        };
      }
      expect(refusals.missingCameras!.requiredCameras).toEqual(FIXTURE.engine.requiredCameras);

      // 4. Checkpoint identity: an engine reporting a different digest fails
      //    the run instead of attributing a result to the wrong checkpoint.
      const identity = await ok<RunDetail>(second, `/api/models/runs/${submitted.identity!}`);
      expect(identity.run.status).toBe("failed");
      expect(identity.attempts.at(-1)!.errorCode).toBe("model_revision_mismatch");
      expect(existsSync(join(e2e.runsRoot, submitted.identity!, "result.json"))).toBe(false);

      // 5. The screens: an open-loop run is labelled by mode, and an unscored
      //    one says so instead of showing a zero error.
      await second.goto(`/dashboard/evaluation/local/${submitted.scored!}`);
      await expect(second.page.getByText("succeeded", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await expect(second.page.getByText("openloop", { exact: true }).first()).toBeVisible();
      await expect(second.page.getByText("Scored against this input's own reference")).toBeVisible();
      await expect(second.page.getByText("not scored", { exact: true })).toHaveCount(0);

      await second.goto(`/dashboard/evaluation/local/${submitted.videoOnly!}`);
      await expect(second.page.getByText("not scored", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await expect(second.page.getByText("This run is not scored")).toBeVisible();

      await second.goto(`/dashboard/evaluation/local/${submitted.identity!}`);
      await expect(second.page.getByText("This run failed")).toBeVisible({ timeout: 60_000 });
      await expect(second.page.getByText("it is not a scored result")).toBeVisible();

      await writeEvidence(testInfo, "model-run-evidence", {
        outcome: "verified",
        lane: "fixture",
        accuracyClaimed: false,
        engine: {
          kind: "deterministic-stub",
          script: STUB_ENDPOINT_SCRIPT,
          family: FIXTURE.engine.family,
          quantization: FIXTURE.engine.quant,
          checkpointDigest: FIXTURE.engine.checkpointDigest,
        },
        modelVersionId: versionId,
        runs: Object.fromEntries(
          Object.entries(submitted).map(([label, runId]) => [label, { runId, worker: terminal[runId] ?? null }]),
        ),
        restart: {
          submittedBy: "session-1",
          executedWith: "no app session open (single-writer data root)",
          readBackBy: "session-2",
        },
        scoredRun: {
          runId: submitted.scored,
          manifestStatus: scoredManifest.status,
          scored: scoredManifest.scored,
          mode: scoredManifest.mode,
          determinismScope: scoredManifest.provenance.model.determinismScope,
          waypoints: openloop.items[0]!.points[0]!.length,
          artifacts: scoredManifest.artifacts.map((artifact) => ({ role: artifact.role, sha256: artifact.sha256 })),
        },
        refusals,
        checkpointIdentity: {
          runId: submitted.identity,
          reportedDigest: FIXTURE.engine.wrongCheckpointDigest,
          expectedDigest: FIXTURE.engine.checkpointDigest,
          errorCode: identity.attempts.at(-1)!.errorCode,
          resultManifestWritten: false,
        },
      });
    } finally {
      await second.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* staging lane — gated on real inputs                                        */
/* -------------------------------------------------------------------------- */

test.describe("staging open-loop upload flow (Alpamayo 1.5 / 2 Super)", () => {
  test("the upload launcher gates the flow on capability before any cloud call", async ({ studio }, testInfo) => {
    test.setTimeout(240_000);
    await studio.goto("/dashboard/evaluation");
    const page = studio.page;

    await expect(page.getByTestId("evaluation-workspace")).toBeVisible({ timeout: 120_000 });
    // The product promise for this flow, stated on the screen: approximate,
    // exploratory, unscored.
    await expect(page.getByText("This exploratory workflow is approximate and unscored.")).toBeVisible();

    const modelStep = page.getByTestId("evaluation-model-step");
    await expect(modelStep).toBeVisible();
    // Only the two families with a reasoning head are offered here, and the
    // uploaded-video flow is cloud-only regardless of local hardware.
    for (const family of FIXTURE.catalog.stagingFamilies) {
      await expect(modelStep.getByRole("button", { name: new RegExp(family.replace(/[.-]/g, "[.\\- ]?"), "i") })).toHaveCount(1);
    }
    await expect(modelStep.getByText("Cloud execution").first()).toBeVisible();
    await expect(modelStep.getByText("trajectory + reasoning").first()).toBeVisible();
    await expect(page.getByTestId("evaluation-input-step")).toBeVisible();
    // Nothing is submittable before an input is prepared.
    await expect(page.getByTestId("evaluation-submit")).toBeDisabled();

    const status = prerequisiteStatus(PREREQUISITES.cloudModels, VIDEO_FIXTURE);
    await writeEvidence(testInfo, "staging-upload-gate", {
      outcome: "verified",
      lane: "fixture",
      accuracyClaimed: false,
      stagingFamilies: FIXTURE.catalog.stagingFamilies,
      cloudOnly: true,
      unscored: true,
      submitEnabledWithoutInput: false,
      stagingLaneRunnable: status.satisfied,
      stagingLaneMissing: status.missing,
    });
  });

  test("an uploaded clip produces a trajectory and reasoning overlay, labelled unscored", async ({ studio }, testInfo) => {
    test.setTimeout(1_800_000);
    // A real staging endpoint and a real decodable video: neither can be
    // synthesized, and a green result without them would be a lie.
    await requirePrerequisites(testInfo, [PREREQUISITES.cloudModels, VIDEO_FIXTURE]);

    const videoPath = process.env.SIMFORGE_E2E_DRIVING_VIDEO!;
    const page = studio.page;
    await studio.goto("/dashboard/evaluation");
    await expect(page.getByTestId("evaluation-workspace")).toBeVisible({ timeout: 120_000 });

    for (const family of FIXTURE.catalog.stagingFamilies) {
      await test.step(`upload and run ${family}`, async () => {
        await page.getByTestId("evaluation-model-step")
          .getByRole("button", { name: new RegExp(family.replace(/[.-]/g, "[.\\- ]?"), "i") })
          .click();
        await page.getByTestId("evaluation-file-input").setInputFiles(videoPath);
        await expect(page.getByTestId("evaluation-file-list")).toBeVisible();
        await page.getByTestId("evaluation-upload-button").click();
        await expect(page.getByTestId("evaluation-input-ready")).toBeVisible({ timeout: 600_000 });
        await expect(page.getByTestId("video-camera-mapping")).toBeVisible();

        const submit = page.getByTestId("evaluation-submit");
        await expect(submit).toBeEnabled();
        await submit.click();

        const detail = page.getByTestId("job-detail");
        await expect(detail).toBeVisible({ timeout: 300_000 });
        await expect(page.getByTestId("uploaded-video-result")).toBeVisible({ timeout: 1_200_000 });
        // The result is a drawable trajectory over the clip, and it is
        // labelled for what it is: exploratory, unscored, approximate rig.
        await expect(page.getByTestId("overlay-svg")).toBeVisible();
        await expect(page.getByText(/Unscored exploratory prediction/)).toBeVisible();
        await expect(page.getByText("Prediction and reasoning overlay")).toBeVisible();

        await writeEvidence(testInfo, `staging-upload-${family}`, {
          outcome: "verified",
          lane: "staging",
          family,
          quantization: "bf16",
          executionTarget: "runpod",
          scored: false,
          labelling: "unscored exploratory prediction",
          overlay: "trajectory + reasoning",
          video: videoPath,
        });
      });
    }
  });
});

test.describe("model store lifecycle against real weights", () => {
  test("a real install verifies deep against the lock, and remove/restart is explicit", async ({ e2e }, testInfo) => {
    test.setTimeout(1_800_000);
    // Real weights are a heavyweight input: 22-72 GB that this suite must
    // never download on its own.
    await requirePrerequisites(testInfo, INSTALLED_WEIGHTS);

    const assetsRoot = process.env.SIMFORGE_E2E_MODEL_ASSETS_ROOT!;
    const family = process.env.SIMFORGE_E2E_MODEL_FAMILY!;
    const context = await createE2eContext({ name: "models-staging" });
    const studio = (await launchBrowserStudio(context, {
      env: { SIMFORGE_ASSETS_ROOT: assetsRoot },
    })) as unknown as StudioLike;
    context.register(() => studio.close());
    try {
      await studio.goto("/dashboard/models");
      await expect(studio.page.getByTestId(`model-card-${family}`)).toBeVisible({ timeout: 120_000 });

      const view = await ok<StoreView>(studio, "/api/models/store");
      const installed = view.installs.find(
        (row) => row.family === family && row.state.state === "installed",
      ) as { quant: string | null; state: { state: string; quant?: string; checkpointDigest?: string; revision?: string } } | undefined;
      expect(installed, `${family} must be installed under ${assetsRoot}`).toBeDefined();
      const quant = installed!.state.quant ?? installed!.quant!;
      await expect(studio.page.getByTestId(`quant-row-${family}-${quant}`)).toContainText("Installed");

      // A deep verify re-hashes every shard: this is the only check that
      // means the bytes on disk are the checkpoint the lock names.
      const verify = await ok<{ ok: boolean; checkpointDigest: string; verified: unknown[]; failed: unknown[] }>(
        studio,
        "/api/models/store/verify",
        { method: "POST", body: { family, deep: true } },
      );
      expect(verify.failed).toHaveLength(0);
      expect(verify.ok).toBe(true);
      expect(verify.verified.length).toBeGreaterThan(0);
      expect(verify.checkpointDigest).toBe(installed!.state.checkpointDigest);

      const evidence: Record<string, unknown> = {
        outcome: "verified",
        lane: "staging",
        family,
        quantization: quant,
        checkpointDigest: verify.checkpointDigest,
        weightsRevision: installed!.state.revision ?? catalogEntry(view, family).weightsRevision,
        deepVerifiedFiles: verify.verified.length,
      };

      const destructive = prerequisiteStatus(DESTRUCTIVE_WEIGHTS);
      if (destructive.satisfied) {
        const removed = await ok<{ freedBytes: number; state: { state: string } }>(
          studio,
          `/api/models/store/${family}?quant=${quant}&purgeSharedCache=false`,
          { method: "DELETE" },
        );
        expect(removed.freedBytes).toBeGreaterThan(0);
        expect(removed.state.state).toBe("not_installed");

        const afterRemoval = await ok<{ ok: boolean }>(studio, "/api/models/store/verify", {
          method: "POST",
          body: { family, deep: false },
        });
        expect(afterRemoval.ok).toBe(false);

        const restart = await api<{ state: { state: string } }>(studio, "/api/models/store/install", {
          method: "POST",
          body: { family, quant, acceptLicense: true, acceptSidecarLicense: true },
        });
        expect(restart.status).toBe(202);
        expect(["downloading", "verifying", "paused"]).toContain(restart.body.state.state);

        const paused = await ok<{ state: { state: string } }>(studio, "/api/models/store/install/pause", {
          method: "POST",
          body: { family },
        });
        expect(["paused", "not_installed", "error"]).toContain(paused.state.state);

        const cancelled = await ok<{ state: { state: string } }>(studio, "/api/models/store/install/cancel", {
          method: "POST",
          body: { family, discardPartials: true },
        });
        expect(cancelled.state.state).toBe("not_installed");
        evidence.removeAndRestart = {
          freedBytes: removed.freedBytes,
          reVerifyOk: false,
          installRestarted: restart.body.state.state,
          cancelled: cancelled.state.state,
        };
      } else {
        evidence.removeAndRestart = { outcome: "prerequisite-missing", missing: destructive.missing };
        await writeEvidence(testInfo, "prerequisite-missing-destructive-weights", {
          outcome: "prerequisite-missing",
          missing: destructive.missing,
        });
        testInfo.annotations.push({
          type: "prerequisite-missing",
          description: "destructive-weights: remove/restart of a real install was not exercised",
        });
      }

      await writeEvidence(testInfo, "real-weights-lifecycle", evidence);
    } finally {
      await context.dispose();
    }
  });
});
