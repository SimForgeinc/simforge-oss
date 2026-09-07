/**
 * The `model_run` job family: leases queued `simforge.model_runs`, spawns (or
 * connects to) the run's endpoint from the descriptor that was resolved into
 * the attempt at first lease, health-checks it, executes the run, and writes
 * artifacts + metrics + the attempt trail.
 *
 * Two kinds execute:
 *
 * - `openloop` — the shared open-loop core (`@simforge-oss/evaluation`
 *   `executeOpenloop`) materialises each `simforge.eval-observations/v1` observation
 *   bundle, invokes the engine's `POST /invoke` facade, and writes
 *   `openloop.json` + `trajectories.json` + `result.json`.
 * - `policy_episode` — the shared episode core (`executeEpisode`) runs one
 *   episode through the native gym runner, scores it, and writes
 *   `trace.jsonl` + `events.json` + `score.json` + `result.json`.
 *
 * Both cores are the same code the cloud worker CLI runs, so a local and a
 * remote run of the same input produce identical documents. Everything lands
 * under `~/simforge-assets/runs/<run_id>/` (override `SIMFORGE_RUNS_ROOT`),
 * and `result.json` (`simforge.eval-result-manifest/v1`) is written last as
 * the completion marker. `artifact` runs stay queued for their executor.
 *
 * Endpoint transports: `http-json` (TCP port or unix socket) serves open loop;
 * `unix-msgpack` descriptors carry the closed-loop policy socket, which the
 * episode runner speaks. An openloop attempt pointed at a msgpack-only
 * endpoint fails with `endpoint_transport_unsupported` — the engine exposes
 * an HTTP facade for exactly this reason.
 *
 * Unlike the render worker this loop talks to the store directly (PGlite is
 * in-process), so it must run in the process that owns the local database:
 * `pnpm exec tsx scripts/model-run-worker.ts`, or any test/script that already
 * imported the data API.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import {
  endpointHealth,
  executeEpisode,
  executeOpenloop,
  isRetryableErrorCode,
  modelIdentityMismatch,
  writeResultManifest,
  type EndpointHealth,
  type EndpointTarget,
  type EvalArtifact,
  type ResultManifest,
} from "@simforge-oss/evaluation";

import {
  OpenloopParamsSchema,
  PolicyEpisodeRunParamsSchema,
  type ModelEndpointDescriptor,
  type ModelRunKind,
} from "../app/lib/models/contracts.js";
import {
  completeModelRun,
  failModelRunAttempt,
  leaseNextModelRun,
  type LeasedModelRun,
} from "../app/lib/models/model-run-store.js";

/** stdio: ["ignore", "pipe", "pipe"] — no stdin, captured stdout/stderr. */
type EndpointChild = ChildProcessByStdio<null, Readable, Readable>;

export type ModelRunWorkerOptions = {
  signal: AbortSignal;
  workerId?: string;
  pollMs?: number;
  runsRoot?: string;
  kinds?: readonly ModelRunKind[];
};

/** A failure with a stable ledger code; anything else becomes `execution_error`. */
export class ModelRunFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function log(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ component: "simforge-model-run-worker", event, ...fields })}\n`);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) { reject(signal.reason); return promise; }
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

export async function runModelRunLoop(options: ModelRunWorkerOptions): Promise<void> {
  const workerId = options.workerId
    ?? `model-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-")}-${process.pid}`;
  const pollMs = options.pollMs ?? 1_000;
  const kinds = options.kinds ?? (["openloop", "policy_episode"] as const);
  const runsRoot = options.runsRoot
    ?? process.env.SIMFORGE_RUNS_ROOT?.trim()
    ?? join(homedir(), "simforge-assets", "runs");
  const signal = options.signal;

  while (!signal.aborted) {
    let lease: LeasedModelRun | null = null;
    try {
      lease = await leaseNextModelRun({ workerId, kinds });
    } catch (error) {
      if (signal.aborted) return;
      log("lease.retry", { error: error instanceof Error ? error.message : String(error) });
      await delay(pollMs, signal).catch(() => undefined);
      continue;
    }
    if (!lease) {
      await delay(pollMs, signal).catch(() => undefined);
      continue;
    }
    log("attempt.started", { runId: lease.runId, attempt: lease.attemptNumber });
    try {
      const result = lease.kind === "policy_episode"
        ? await executePolicyEpisodeRun(lease, { runsRoot, signal })
        : await executeOpenloopRun(lease, { runsRoot, signal });
      await completeModelRun(lease, result);
      log("run.succeeded", { runId: lease.runId, attempt: lease.attemptNumber, metrics: result.metrics });
    } catch (error) {
      const code = error instanceof ModelRunFailure ? error.code : "execution_error";
      const message = error instanceof Error ? error.message : String(error);
      const { runStatus } = await failModelRunAttempt(lease, {
        errorCode: code,
        errorDetail: { message: message.slice(0, 2_000) },
      });
      log("attempt.failed", { runId: lease.runId, attempt: lease.attemptNumber, code, runStatus });
      if (signal.aborted) return;
    }
  }
}

async function freeTcpPort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => port
      ? resolve(port)
      : reject(new Error("could not allocate a TCP port")));
  });
  return promise;
}

type EndpointHandle = {
  descriptor: ModelEndpointDescriptor;
  port: number | null;
  socketPath: string | null;
  child: EndpointChild | null;
  stdout: string[];
  spawnMs: number;
  healthMs: number;
  stop(): Promise<void>;
};

async function startEndpoint(
  descriptor: ModelEndpointDescriptor,
  signal: AbortSignal,
): Promise<EndpointHandle> {
  const spawnStarted = Date.now();
  let child: EndpointChild | null = null;
  let port: number | null = null;
  const stdout: string[] = [];
  let exited: Promise<void> = Promise.resolve();

  if (descriptor.kind === "process") {
    if (descriptor.invoke.kind === "http-json" && !descriptor.socketPath) {
      port = await freeTcpPort();
    }
    const [command, ...args] = descriptor.cmd;
    child = spawn(command!, args, {
      cwd: descriptor.cwd,
      env: {
        ...process.env,
        ...descriptor.env,
        ...(port !== null ? { [descriptor.portEnv]: String(port) } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const spawned = child;
    spawned.stdout.setEncoding("utf8");
    spawned.stderr.setEncoding("utf8");
    spawned.stdout.on("data", (chunk: string) => { stdout.push(chunk); });
    spawned.stderr.on("data", () => undefined);
    const exit = Promise.withResolvers<void>();
    spawned.once("exit", () => exit.resolve());
    exited = exit.promise;
  }

  const handle: EndpointHandle = {
    descriptor,
    port,
    socketPath: descriptor.socketPath ?? null,
    child,
    stdout,
    spawnMs: Date.now() - spawnStarted,
    healthMs: 0,
    stop: async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => { child?.kill("SIGKILL"); }, 5_000);
      await exited;
      clearTimeout(killTimer);
    },
  };

  const healthStarted = Date.now();
  try {
    await waitForHealth(handle, signal);
  } catch (error) {
    await handle.stop();
    throw error;
  }
  handle.healthMs = Date.now() - healthStarted;
  return handle;
}

async function waitForHealth(handle: EndpointHandle, signal: AbortSignal): Promise<void> {
  const health = handle.descriptor.health;
  const deadline = Date.now() + health.timeoutMs;
  const pattern = health.kind === "stdout" ? new RegExp(health.pattern, "m") : null;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ModelRunFailure("worker_stopped", "worker stopped during health check");
    if (handle.child && handle.child.exitCode !== null) {
      throw new ModelRunFailure(
        "endpoint_exited",
        `endpoint process exited with code ${handle.child.exitCode} before becoming healthy`,
      );
    }
    if (health.kind === "stdout") {
      if (pattern!.test(handle.stdout.join(""))) return;
    } else if (health.kind === "http") {
      if (handle.port === null) {
        throw new ModelRunFailure("endpoint_descriptor_invalid", "http health check requires a TCP endpoint");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${handle.port}${health.path}`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
      } catch { /* not up yet */ }
    } else {
      const socketPath = health.path ?? handle.socketPath;
      if (!socketPath) {
        throw new ModelRunFailure("endpoint_descriptor_invalid", "socket health check requires a socket path");
      }
      const probe = Promise.withResolvers<boolean>();
      const socket = connect(socketPath, () => { socket.destroy(); probe.resolve(true); });
      socket.once("error", () => { socket.destroy(); probe.resolve(false); });
      const connected = await probe.promise;
      if (connected) return;
    }
    await delay(200, signal);
  }
  throw new ModelRunFailure("endpoint_unhealthy", `endpoint failed its ${health.kind} health check within ${health.timeoutMs}ms`);
}

/** Where this endpoint handle is reachable for HTTP `/invoke` + `/healthz`. */
function targetOf(handle: EndpointHandle): EndpointTarget {
  const timeoutMs = handle.descriptor.invoke.kind === "http-json" ? handle.descriptor.invoke.timeoutMs : 600_000;
  if (handle.socketPath) return { url: `unix:${handle.socketPath}`, timeoutMs };
  if (handle.port === null) {
    throw new ModelRunFailure("endpoint_descriptor_invalid", "http-json invoke requires a TCP port or socket path");
  }
  return { url: `http://127.0.0.1:${handle.port}`, timeoutMs };
}

/**
 * Refuse before inference when the engine is not the model this run names.
 *
 * The registry row already pins family/revision/quant; a run whose engine
 * reports something else would produce numbers attributed to the wrong model.
 */
async function requireEngineIdentity(
  handle: EndpointHandle,
  expected: { family: string; revision: string; quant: string } | null,
): Promise<EndpointHealth> {
  const health = await endpointHealth(targetOf(handle));
  if (!expected) return health;
  const mismatch = modelIdentityMismatch(health, expected);
  if (mismatch.length > 0) {
    throw new ModelRunFailure("model_revision_mismatch", mismatch.join("; "));
  }
  return health;
}

function manifestBase(lease: LeasedModelRun): Pick<ResultManifest, "schema" | "runId" | "attemptId" | "jobId" | "workspaceId"> {
  return {
    schema: "simforge.eval-result-manifest/v1",
    runId: lease.runId,
    attemptId: String(lease.attemptNumber),
    jobId: null,
    workspaceId: null,
  };
}

function outputRefs(runDir: string, artifacts: readonly EvalArtifact[]): unknown[] {
  return [
    { kind: "directory", path: runDir },
    { kind: "file", path: join(runDir, "result.json") },
    ...artifacts.map((artifact) => ({ kind: "file", path: join(runDir, artifact.path), role: artifact.role })),
  ];
}

export async function executeOpenloopRun(
  lease: LeasedModelRun,
  options: { runsRoot: string; signal: AbortSignal },
): Promise<{ metrics: Record<string, unknown>; outputRefs: unknown[] }> {
  if (lease.kind !== "openloop") {
    throw new ModelRunFailure("unsupported_run_kind", `no openloop executor for run kind ${lease.kind}`);
  }
  const params = OpenloopParamsSchema.safeParse(lease.params);
  if (!params.success) {
    throw new ModelRunFailure(
      "invalid_openloop_params",
      params.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
    );
  }
  const descriptor = lease.resolvedDescriptor;
  if (descriptor.invoke.kind !== "http-json") {
    throw new ModelRunFailure(
      "endpoint_transport_unsupported",
      `openloop needs the engine's http-json facade; this endpoint declares ${descriptor.invoke.kind}. ` +
        "Start the engine with --http and register an http-json invoke.",
    );
  }

  const runDir = join(options.runsRoot, lease.runId);
  await mkdir(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const endpoint = await startEndpoint(descriptor, options.signal);
  try {
    const health = await requireEngineIdentity(endpoint, lease.modelIdentity ?? null);
    const outcome = await executeOpenloop({
      runId: lease.runId,
      attemptId: String(lease.attemptNumber),
      params: params.data,
      target: targetOf(endpoint),
      health,
      outDir: runDir,
      // Host runs name their bundles by path; there is no job input table.
      resolveInput: (item) => {
        const ref = item.ref;
        if (!ref) {
          throw new ModelRunFailure("invalid_openloop_params", `item ${item.role ?? "?"} has no local \`ref\` path`);
        }
        return ref;
      },
      signal: options.signal,
      fallbackModel: lease.modelIdentity ?? undefined,
    });
    const completedAt = new Date().toISOString();
    await writeResultManifest(runDir, {
      ...manifestBase(lease),
      kind: params.data.task === "text" ? "text" : "openloop",
      status: outcome.status,
      scored: outcome.scored,
      promotable: outcome.scored && outcome.status === "succeeded",
      exploratory: outcome.exploratory,
      mode: "openloop",
      truncation: outcome.status === "cancelled" ? "cancelled" : null,
      metrics: { ...outcome.metrics, spawnMs: endpoint.spawnMs, healthMs: endpoint.healthMs },
      artifacts: [...outcome.artifacts],
      provenance: {
        model: {
          family: (outcome.model["family"] as string | null) ?? null,
          revision: (outcome.model["revision"] as string | null) ?? null,
          checkpointDigest: (outcome.model["checkpointDigest"] as string | null) ?? null,
          quant: (outcome.model["quant"] as string | null) ?? null,
          attn: (outcome.model["attn"] as string | null) ?? null,
          torch: (outcome.model["torch"] as string | null) ?? null,
          cuda: (outcome.model["cuda"] as string | null) ?? null,
          diffusionSteps: (outcome.model["diffusionSteps"] as number | null) ?? null,
          numTrajSamples: (outcome.model["numTrajSamples"] as number | null) ?? null,
          cameraProfile: (outcome.model["cameraProfile"] as string | null) ?? null,
          rngProvenance: (outcome.model["rngProvenance"] as Record<string, unknown> | null) ?? null,
          determinismScope: "same-host-same-device",
        },
        input: { kind: outcome.inputKind, ref: null, digest: outcome.inputDigest, ood: [], replayContext: null },
        runtime: { host: "desktop", worker: "model-run", node: process.version },
        controller: {},
        compute: null,
        metricVersion: "simforge.eval-metrics/v1",
      },
      timing: {
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        executionMs: null,
      },
      error: null,
    });
    return { metrics: outcome.metrics, outputRefs: outputRefs(runDir, outcome.artifacts) };
  } finally {
    await endpoint.stop();
  }
}

/**
 * `policy_episode`: one closed-loop episode through the native gym runner.
 *
 * A model episode needs the engine's MessagePack policy socket (frames are
 * shared memory, never HTTP), so the endpoint descriptor must carry a
 * `socketPath`. The episode's own artifacts and `result.json` land in the run
 * directory the eval tab already reads.
 */
export async function executePolicyEpisodeRun(
  lease: LeasedModelRun,
  options: { runsRoot: string; signal: AbortSignal },
): Promise<{ metrics: Record<string, unknown>; outputRefs: unknown[] }> {
  if (lease.kind !== "policy_episode") {
    throw new ModelRunFailure("unsupported_run_kind", `no episode executor for run kind ${lease.kind}`);
  }
  const parsed = PolicyEpisodeRunParamsSchema.safeParse(lease.params);
  if (!parsed.success) {
    throw new ModelRunFailure(
      "invalid_episode_params",
      parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
    );
  }
  const params = parsed.data;
  const descriptor = lease.resolvedDescriptor;
  const runDir = join(options.runsRoot, lease.runId);
  await mkdir(runDir, { recursive: true });
  const startedAt = new Date().toISOString();

  const needsEngine = params.runnerPolicy === "endpoint";
  if (needsEngine && !descriptor.socketPath) {
    throw new ModelRunFailure(
      "endpoint_transport_unsupported",
      "a model episode needs the endpoint's unix socket (msgpack policy wire); this descriptor has none",
    );
  }
  const endpoint = needsEngine ? await startEndpoint(descriptor, options.signal) : null;
  try {
    const outcome = await executeEpisode({
      runId: lease.runId,
      outDir: runDir,
      signal: options.signal,
      scoring: params.scoring,
      expectedRouteM: params.expectedRouteM,
      speedLimitMps: params.speedLimitMps,
      runner: {
        specPath: params.spec,
        session: params.session,
        runnerPolicy: params.runnerPolicy,
        seed: params.seed,
        policySeed: params.policySeed,
        steps: params.steps,
        mode: params.mode,
        deadlineMs: params.deadlineMs,
        fallback: params.fallback,
        execution: params.execution,
        decisionHz: params.decisionHz,
        tracePath: join(runDir, "trace.jsonl"),
        forceMissAt: params.forceMissAt,
        replayContextDir: params.replayContext,
        endpointSocket: endpoint?.socketPath ?? null,
        cameraProfile: params.cameraProfile,
        frameSource: params.frameSource,
        replanHz: params.replanHz,
        numTrajSamples: params.numTrajSamples,
        navText: params.navText,
        model: lease.modelIdentity ?? null,
        allowColdStart: params.allowColdStart,
        warmupPolicy: params.warmupPolicy,
        warmupSteps: params.warmupSteps,
      },
    });
    const completedAt = new Date().toISOString();
    await writeResultManifest(runDir, {
      ...manifestBase(lease),
      kind: "closedloop-episode",
      status: outcome.status,
      scored: outcome.scored,
      promotable: outcome.scored && outcome.status === "succeeded" && params.runnerPolicy === "endpoint",
      exploratory: false,
      mode: params.mode,
      truncation: outcome.truncation,
      metrics: outcome.metrics,
      artifacts: [...outcome.artifacts],
      provenance: {
        model: outcome.model
          ? {
              family: (outcome.model["family"] as string | null) ?? null,
              revision: (outcome.model["revision"] as string | null) ?? null,
              checkpointDigest: (outcome.model["checkpointDigest"] as string | null) ?? null,
              quant: (outcome.model["quant"] as string | null) ?? null,
              attn: (outcome.model["attn"] as string | null) ?? null,
              torch: (outcome.model["torch"] as string | null) ?? null,
              cuda: (outcome.model["cuda"] as string | null) ?? null,
              diffusionSteps: null,
              numTrajSamples: params.numTrajSamples,
              cameraProfile: params.cameraProfile,
              rngProvenance: (outcome.model["rngProvenance"] as Record<string, unknown> | null) ?? null,
              determinismScope: "same-host-same-device",
            }
          : null,
        input: {
          kind: params.replayContext ? "replay-context" : "scenario",
          ref: params.spec,
          digest: null,
          ood: [],
          replayContext: null,
        },
        runtime: { host: "desktop", worker: "model-run", node: process.version },
        controller: { execution: params.execution, decisionHz: params.decisionHz, fallback: params.fallback },
        compute: null,
        metricVersion: "simforge.eval-metrics/v1",
      },
      timing: {
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        executionMs: null,
      },
      error: outcome.error
        ? {
            code: /camera|capability|frame|replay_context|revision|unsupported/.test(outcome.error.code)
              ? "capability_error"
              : "internal",
            retryable: isRetryableErrorCode(
              /camera|capability|frame|replay_context|revision|unsupported/.test(outcome.error.code)
                ? "capability_error"
                : "internal",
            ),
            message: outcome.error.message,
            fields: [outcome.error.code],
          }
        : null,
    });
    if (outcome.status === "failed") {
      throw new ModelRunFailure(
        outcome.error?.code ?? "episode_failed",
        outcome.error?.message ?? "episode produced no scoreable result",
      );
    }
    return { metrics: outcome.metrics, outputRefs: outputRefs(runDir, outcome.artifacts) };
  } finally {
    if (endpoint) await endpoint.stop();
  }
}
