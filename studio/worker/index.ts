import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { simforgeEnv } from "../lib/simforge-env";

import { loadBuiltinRenderEngine, type RenderProgressRecord, type WorkerRegisteredResponse } from "@simforge-oss/render";
import { probeLocalBrowserRender, probeLocalCarlaRender, probeLocalNativeRender, NativeTextureCapacityError, NativeMapCapacityError } from "@simforge-oss/render/native";

import { runCompilerLoop } from "./compiler.js";
import { runSimulationLoop } from "./simulate.js";
import { executeRender } from "./executor.js";
import { CpuJobsClient, downloadInputs } from "./http-client.js";
import { NativeMapFailure, runNativeClaim } from "./native-render.js";
import type { CpuJobClaim, LocalRenderEngine } from "./types.js";
import { runCarlaClaim } from "./carla-render.js";
import { RenderControlClient } from "./render-control-client.js";

export const WORKER_CAPABILITIES = [
  "native-render",
  "browser-render",
  "carla-render",
  "compile",
  "simulate",
  "model-run",
] as const;
export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number];

function configuredCapabilities(): ReadonlySet<WorkerCapability> | null {
  const raw = simforgeEnv("WORKER_CAPABILITIES")?.trim();
  if (!raw) return null;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = values.filter((value): value is string => !(WORKER_CAPABILITIES as readonly string[]).includes(value));
  if (unknown.length > 0) throw new Error(`Unknown worker capability: ${unknown.join(", ")}`);
  return new Set(values as WorkerCapability[]);
}

export type LocalWorkerHandle = {
  readonly done: Promise<void>;
  stop(reason?: unknown): void;
};

export function offeredEngines(): { engines: LocalRenderEngine[]; reasons: Record<LocalRenderEngine, readonly string[]> } {
  const configured = configuredCapabilities();
  const native = probeLocalNativeRender();
  const browser = probeLocalBrowserRender(process.env, chromium.executablePath());
  const carla = probeLocalCarlaRender();
  const engines: LocalRenderEngine[] = [];
  if (browser.ready && (!configured || configured.has("browser-render"))) engines.push("browser");
  if (native.ready && (!configured || configured.has("native-render"))) engines.push("native");
  if (carla.ready && (!configured || configured.has("carla-render"))) engines.push("carla");
  return { engines, reasons: { browser: browser.reasons, native: native.reasons, carla: carla.reasons } };
}

export function startLocalWorker(baseUrl: string | URL): LocalWorkerHandle {
  const controller = new AbortController();
  const token = simforgeEnv("RENDER_WORKER_TOKEN")?.trim()
    || simforgeEnv("LOCAL_HOST_TOKEN")?.trim()
    || "simforge-local-worker";
  const workerId = simforgeEnv("RENDER_WORKER_ID")?.trim()
    || `local-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-")}-${process.pid}`;
  const configured = configuredCapabilities();
  const offered = offeredEngines();
  process.stdout.write(`${JSON.stringify({
    component: "simforge-local-render-worker",
    event: "worker.engines",
    engines: offered.engines,
    capabilities: configured ? [...configured] : ["native-render", "browser-render", "carla-render", "compile"],
    unavailable: Object.fromEntries(Object.entries(offered.reasons).filter(([, reasons]) => reasons.length > 0)),
  })}\n`);
  // The runtime can be installed while this worker runs (onboarding offers
  // it); the probe is a few stats, so each poll offers what is on disk now
  // and announces a change the same way the first poll did.
  let announced = offered.engines.join(",");
  const client = new CpuJobsClient(new URL(baseUrl), token, workerId, () => {
    const now = offeredEngines();
    const key = now.engines.join(",");
    if (key !== announced) {
      announced = key;
      process.stdout.write(`${JSON.stringify({
        component: "simforge-local-render-worker",
        event: "worker.engines",
        engines: now.engines,
        capabilities: configured ? [...configured] : ["native-render", "browser-render", "carla-render", "compile"],
        unavailable: Object.fromEntries(Object.entries(now.reasons).filter(([, reasons]) => reasons.length > 0)),
      })}\n`);
    }
    return now.engines.filter((engine) => engine !== "carla");
  });
  const loops: Promise<void>[] = [];
  if (!configured || configured.has("browser-render") || configured.has("native-render")) {
    loops.push(runClaimLoop(client, controller.signal));
  }
  if (!configured || configured.has("carla-render")) {
    loops.push(runCarlaLoop(new RenderControlClient(new URL(baseUrl), token, workerId, client), controller.signal));
  }
  // A compiler also serves queued authoritative simulations: they are the
  // same CPU work on the same map closures, and a host that cannot simulate a
  // request inline must never be left without a runner.
  if (!configured || configured.has("compile") || configured.has("simulate")) {
    loops.push(runSimulationLoop(baseUrl, token, controller.signal));
  }
  if (!configured || configured.has("compile")) {
    loops.push(runCompilerLoop(baseUrl, token, controller.signal));
  }
  const done = Promise.all(loops).then(() => undefined);
  return {
    done,
    stop(reason = new Error("local render worker stopped")) {
      controller.abort(reason);
    },
  };
}

async function runClaimLoop(client: CpuJobsClient, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const claim = await client.claim(signal);
      if (!claim) {
        await delay(1_000, signal);
        continue;
      }
      await runClaim(client, claim, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      process.stderr.write(`${JSON.stringify({
        component: "simforge-local-render-worker",
        event: "claim.retry",
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
      await delay(1_000, signal);
    }
  }
}

/**
 * The machine's own identity, as the plane's registration contract demands it:
 * `hardwareProfile`, `gpuModel` and `gpuMemoryMiB` are mandatory, and one of
 * `imageDigest` (container) or `codeDigest` (host-native) must be a sha256
 * digest. These describe the hardware and the build, so they are read from the
 * environment the deployment sets rather than probed or invented here; a
 * missing one fails loudly instead of registering a worker that lies about
 * what it is.
 */
function carlaWorkerLabels(): Record<string, string> {
  const required = (name: string): string => {
    const value = simforgeEnv(name)?.trim();
    if (!value) throw new Error(`SIMFORGE_${name} is required to register a CARLA worker`);
    return value;
  };
  const digest = simforgeEnv("WORKER_IMAGE_DIGEST")?.trim() || simforgeEnv("WORKER_CODE_DIGEST")?.trim();
  if (!digest) throw new Error("SIMFORGE_WORKER_IMAGE_DIGEST or SIMFORGE_WORKER_CODE_DIGEST is required");
  const digestKey = simforgeEnv("WORKER_IMAGE_DIGEST")?.trim() ? "imageDigest" : "codeDigest";
  const labels: Record<string, string> = {
    hardwareProfile: required("WORKER_HARDWARE_PROFILE"),
    gpuModel: required("WORKER_GPU_MODEL"),
    gpuMemoryMiB: required("WORKER_GPU_MEMORY_MIB"),
    [digestKey]: digest,
  };
  for (const name of ["BASE_IMAGE", "BASE_IMAGE_DIGEST", "BASE_IMAGE_PLATFORM_DIGEST"]) {
    const value = simforgeEnv(`WORKER_${name}`)?.trim();
    if (value) labels[name.toLowerCase().replace(/_(.)/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return labels;
}

async function runCarlaLoop(client: RenderControlClient, signal: AbortSignal): Promise<void> {
  let registration: WorkerRegisteredResponse | undefined;
  while (!signal.aborted) {
    try {
      if (!offeredEngines().engines.includes("carla")) {
        await delay(1_000, signal);
        continue;
      }
      if (!registration) {
        const engine = await loadBuiltinRenderEngine("carla");
        try {
          registration = await client.register(engine.capabilities, randomUUID(), carlaWorkerLabels(), signal);
        } finally {
          await engine.close?.();
        }
      }
      const claim = await client.claim(registration.registrationId, signal);
      if (claim.type === "job.none") {
        await delay(claim.retryAfterMs, signal);
        continue;
      }
      const root = simforgeEnv("LOCAL_WORKER_ROOT")?.trim() || join(homedir(), ".simforge", "cloud", "worker");
      const workspace = join(root, `${claim.jobId}-${claim.lease.leaseId}`);
      process.stdout.write(`${JSON.stringify({ component: "simforge-local-render-worker", event: "job.started", jobId: claim.jobId, engine: "carla" })}\n`);
      const job = new AbortController();
      const jobSignal = AbortSignal.any([signal, job.signal]);
      let sequence = 0;
      let acceptedSequence = 0;
      const heartbeat = (async () => {
        while (!jobSignal.aborted) {
          await delay(registration.heartbeatIntervalMs, jobSignal).catch(() => undefined);
          if (jobSignal.aborted) return;
          try {
            const response = await client.heartbeat(claim, acceptedSequence, jobSignal);
            if (response.cancelRequested) job.abort(new Error(response.cancelReason ?? "render cancelled"));
          } catch (error) {
            job.abort(error);
          }
        }
      })();
      try {
        await rm(workspace, { recursive: true, force: true });
        const outcome = await runCarlaClaim(client, claim, workspace, jobSignal, async (record) => {
          const response = await client.progress(claim, [{
            ...record, jobId: claim.jobId, attempt: claim.attempt, sequence: sequence++,
          }], jobSignal);
          acceptedSequence = response.acceptedThroughSequence;
        });
        process.stdout.write(`${JSON.stringify({ component: "simforge-local-render-worker", event: "job.completed", jobId: claim.jobId, engine: "carla", ...outcome })}\n`);
      } catch (error) {
        if (!signal.aborted) {
          process.stderr.write(`${JSON.stringify({ component: "simforge-local-render-worker", event: "job.failed", jobId: claim.jobId, engine: "carla", error: error instanceof Error ? error.message : String(error) })}\n`);
          await client.fail(claim, error, AbortSignal.timeout(30_000));
        }
      } finally {
        job.abort(new Error("render attempt finished"));
        await heartbeat;
        await rm(workspace, { recursive: true, force: true });
      }
    } catch (error) {
      if (signal.aborted) return;
      process.stderr.write(`${JSON.stringify({ component: "simforge-local-render-worker", event: "claim.retry", engine: "carla", error: error instanceof Error ? error.message : String(error) })}\n`);
      await delay(1_000, signal);
    }
  }
}

async function runClaim(client: CpuJobsClient, claim: CpuJobClaim, workerSignal: AbortSignal): Promise<void> {
  const root = simforgeEnv("LOCAL_WORKER_ROOT")?.trim()
    || join(homedir(), ".simforge", "cloud", "worker");
  const workspace = join(root, `${claim.jobId}-${claim.attemptId}`);
  await rm(workspace, { recursive: true, force: true });
  const job = new AbortController();
  const signal = AbortSignal.any([workerSignal, job.signal]);
  let progress = 0;
  const heartbeat = runHeartbeat(client, claim, () => progress, job, workerSignal);
  const reportProgress = async (record: RenderProgressRecord) => {
    progress = progressOf(record, progress);
    if (record.event === "stage.progress") {
      await client.event(claim, "stage.progress", {
        stage: record.stage,
        completed: record.completed,
        total: record.total,
        unit: record.unit,
      }, signal);
    }
  };
  try {
    await client.event(claim, "job.started", { engine: claim.payload.engine }, signal);
    if (claim.payload.mode === "native_render") {
      const outcome = await runNativeClaim(
        client,
        { ...claim, payload: claim.payload },
        workspace,
        join(root, "map-cache"),
        signal,
        reportProgress,
      );
      job.abort(new Error("render complete"));
      await heartbeat;
      process.stdout.write(`${JSON.stringify({
        component: "simforge-local-render-worker",
        event: "job.completed",
        jobId: claim.jobId,
        engine: "native",
        frameCount: outcome.frameCount,
        artifactCount: outcome.artifactCount,
      })}\n`);
      return;
    }
    const inputs = await downloadInputs(claim.payload.inputs, join(workspace, "inputs"), signal, client.hostOrigin);
    const result = await executeRender({
      jobId: claim.jobId,
      attempt: 1,
      engine: claim.payload.engine,
      intent: claim.payload.intent,
      intentSha256: claim.payload.intentSha256,
      inputs,
      workspace,
      signal,
      reportProgress,
    });
    progress = 0.95;
    const recording = await client.reserve(claim, result.artifacts, signal);
    let uploadedArtifacts = 0;
    await client.recordingProgress(
      recording.recordingId,
      uploadedArtifacts,
      result.artifacts.length,
      signal,
    );
    for (const artifact of result.artifacts) {
      const key = artifact.sensor
        ? `${artifact.kind}\0${artifact.sensor.actorId}\0${artifact.sensor.sensorId}\0${artifact.sensor.modality}`
        : artifact.kind;
      const reservation = recording.uploads.find((item) => item.key === key);
      if (!reservation) throw new Error(`missing upload reservation for ${key}`);
      await client.upload(reservation, artifact, signal);
      uploadedArtifacts += 1;
      await client.recordingProgress(
        recording.recordingId,
        uploadedArtifacts,
        result.artifacts.length,
        signal,
      );
    }
    job.abort(new Error("render complete"));
    await heartbeat;
    await client.complete(claim, recording.recordingId, result.artifacts, recording.uploads, workerSignal);
    process.stdout.write(`${JSON.stringify({
      component: "simforge-local-render-worker",
      event: "job.completed",
      jobId: claim.jobId,
      engine: "browser",
      frameCount: result.frameCount,
      durationSeconds: result.durationSeconds,
    })}\n`);
  } catch (error) {
    job.abort(error);
    await heartbeat.catch(() => undefined);
    if (workerSignal.aborted) throw workerSignal.reason;
    const detail = error instanceof Error ? error.message : String(error);
    await client.fail(claim, failureCode(error), { message: detail.slice(0, 2_000) }, AbortSignal.timeout(30_000));
    process.stderr.write(`${JSON.stringify({
      component: "simforge-local-render-worker",
      event: "job.failed",
      jobId: claim.jobId,
      error: detail,
    })}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runHeartbeat(
  client: CpuJobsClient,
  claim: CpuJobClaim,
  progress: () => number,
  job: AbortController,
  workerSignal: AbortSignal,
): Promise<void> {
  while (!job.signal.aborted && !workerSignal.aborted) {
    await delay(10_000, AbortSignal.any([job.signal, workerSignal])).catch(() => undefined);
    if (job.signal.aborted || workerSignal.aborted) return;
    try {
      const result = await client.heartbeat(claim, progress(), workerSignal);
      if (result.cancelRequested) {
        job.abort(new Error("render cancellation requested by control plane"));
        return;
      }
    } catch (error) {
      job.abort(error);
      return;
    }
  }
}

function progressOf(record: RenderProgressRecord, previous: number): number {
  if (record.event !== "stage.progress" || record.total <= 0) return previous;
  return Math.max(previous, Math.min(0.9, (record.completed / record.total) * 0.9));
}

function failureCode(error: unknown): string {
  if (error instanceof NativeMapFailure) return error.code;
  if (error instanceof NativeTextureCapacityError || error instanceof NativeMapCapacityError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (/digest|integrity|invalid|missing|undeclared|mismatch/i.test(message)) return "render_invalid_input";
  if (/cancel/i.test(message)) return "render_cancelled";
  return "render_execution_failed";
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      rejectPromise(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", abort);
      resolvePromise();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function main(): Promise<void> {
  const baseUrl = simforgeEnv("API_BASE_URL")?.trim() || "http://127.0.0.1:5199";
  process.stdout.write(`${JSON.stringify({
    component: "simforge-local-render-worker",
    event: "worker.started",
    baseUrl,
  })}\n`);
  const worker = startLocalWorker(baseUrl);
  const stop = (name: string) => worker.stop(new Error(`received ${name}`));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await worker.done;
}

const entryHref = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === entryHref || entryHref.endsWith("/worker/index.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      component: "simforge-local-render-worker",
      event: "worker.failed",
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
