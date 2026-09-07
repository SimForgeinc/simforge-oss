import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { RenderInputFile, RenderProgressRecord } from "@simforge-oss/render";
import { assertSafeNativeMapMemberPath, createRenderEngine } from "@simforge-oss/render/native";

import { executeEngine, safeArtifactPath } from "./executor.js";
import { downloadInputs, type CpuJobsClient } from "./http-client.js";
import type {
  CpuJobClaim,
  EngineExecution,
  NativeArtifactIdentity,
  NativeCompletionArtifact,
  NativeMapMember,
  NativeRenderClaimPayload,
} from "./types.js";

/**
 * The local native (Bevy) render lane of the worker.
 *
 * Small immutable inputs (OpenSCENARIO, OpenDRIVE, catalog, actor closure)
 * are fetched per attempt and hashed. The map is not: the host ensures the
 * real semantic map directory (authorization, download, materialization) and
 * this lane proves every declared closure member's bytes in place before the
 * engine sees the directory. Outputs are reserved one identity at a time,
 * streamed to the local object store, and completed with the engine's own
 * evidence so the host can fence success on it.
 */

const MAP_POLL_MS = 2_000;
export type NativeRenderOutcome = { readonly frameCount: number; readonly artifactCount: number };

type StageProgress = Extract<RenderProgressRecord, { event: "stage.progress" }>;
type StageProgressReporter = (record: Pick<StageProgress, "stage" | "completed" | "total" | "unit">) => Promise<void>;

export async function runNativeClaim(
  client: CpuJobsClient,
  claim: CpuJobClaim & { readonly payload: NativeRenderClaimPayload },
  workspace: string,
  signal: AbortSignal,
  reportProgress: (record: RenderProgressRecord) => Promise<void>,
): Promise<NativeRenderOutcome> {
  const { payload } = claim;
  const progress: StageProgressReporter = (record) =>
    reportProgress({
      schema: "simforge.render-progress/v1",
      jobId: claim.jobId,
      attempt: payload.attemptNumber,
      sequence: 0,
      timestamp: new Date().toISOString(),
      event: "stage.progress",
      ...record,
    });

  await progress({ stage: "downloading", completed: 0, total: payload.inputs.length, unit: "items" });
  const fetched = await downloadInputs(payload.inputs, join(workspace, "inputs"), signal);
  await progress({ stage: "downloading", completed: payload.inputs.length, total: payload.inputs.length, unit: "items" });

  const directory = await awaitPreparedMap(client, claim, signal, progress);
  const mapInputs = await verifyMapClosure(directory, payload.map.members, signal, progress);
  const inputs = new Map<string, RenderInputFile>([...fetched, ...mapInputs]);

  const engine = createRenderEngine();
  let execution: EngineExecution;
  try {
    execution = await executeEngine({
      jobId: claim.jobId,
      attempt: payload.attemptNumber,
      engine: "native",
      intent: payload.intent,
      intentSha256: payload.intentSha256,
      executionPackageControlSha256: payload.executionPackageControlSha256,
      inputs,
      workspace,
      signal,
      reportProgress,
    }, engine);
  } finally {
    await engine.close?.();
  }

  const artifacts: NativeCompletionArtifact[] = [];
  const total = execution.runtimeManifest.artifacts.length;
  await progress({ stage: "uploading", completed: 0, total, unit: "items" });
  for (const artifact of execution.runtimeManifest.artifacts) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("native render aborted");
    const identity = artifact.identity as NativeArtifactIdentity;
    const path = safeArtifactPath(workspace, artifact.relativePath);
    const reservation = await client.reserveNativeArtifact(
      claim,
      { identity, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, mediaType: artifact.mediaType },
      signal,
    );
    await client.uploadNativeArtifact(reservation, path, signal);
    artifacts.push({
      artifactId: reservation.artifactId,
      identity,
      path,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      mediaType: artifact.mediaType,
    });
    await progress({ stage: "uploading", completed: artifacts.length, total, unit: "items" });
  }
  await progress({ stage: "finalizing", completed: 0, total: 1, unit: "items" });
  await client.completeNative(claim, execution.intentSha256, artifacts, signal);
  return { frameCount: execution.frameCount, artifactCount: artifacts.length };
}

/**
 * Polls the host's map preparation while the heartbeat keeps the lease.
 * A failed preparation (not authorized, download failed) is the attempt's
 * failure with the host's code; the job is never rendered against a stand-in.
 */
async function awaitPreparedMap(
  client: CpuJobsClient,
  claim: CpuJobClaim,
  signal: AbortSignal,
  progress: StageProgressReporter,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("native render aborted");
    const preparation = await client.prepareMap(claim, signal);
    if (preparation.state === "ready") return preparation.directory;
    if (preparation.state === "failed") {
      throw new NativeMapFailure(preparation.code, `map preparation failed: ${preparation.message}`);
    }
    const elapsed = Math.round((Date.now() - started) / 1_000);
    await progress({ stage: "preparing", completed: elapsed, total: elapsed + 1, unit: "seconds" });
    await delay(MAP_POLL_MS, undefined, { signal }).catch((error: unknown) => {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("native render aborted");
      throw error;
    });
  }
}

/** A map the host could not provide for this attempt; `code` is the host's reason (e.g. `map_not_authorized`). */
export class NativeMapFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeMapFailure";
  }
}

async function digestFile(path: string, signal: AbortSignal): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

/**
 * Proves the ensured directory holds exactly the intent's declared closure:
 * every member at its closure-relative path with the declared sha256 and
 * size. The directory is used in place afterwards, so this is the only
 * point at which its bytes are bound to the intent.
 */
async function verifyMapClosure(
  directory: string,
  members: readonly NativeMapMember[],
  signal: AbortSignal,
  progress: StageProgressReporter,
): Promise<Map<string, RenderInputFile>> {
  const root = resolve(directory);
  const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  let verifiedBytes = 0;
  let lastReport = 0;
  const inputs = new Map<string, RenderInputFile>();
  for (const member of members) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("native render aborted");
    assertSafeNativeMapMemberPath(member.relativePath);
    const path = resolve(root, member.relativePath);
    if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error(`map member escapes the map directory: ${member.relativePath}`);
    const stats = await stat(path).catch(() => null);
    if (!stats?.isFile() || stats.size !== member.sizeBytes) {
      throw new Error(`map member ${member.relativePath} is missing or has ${stats?.size ?? "no"} bytes; the intent declares ${member.sizeBytes}`);
    }
    const actual = await digestFile(path, signal);
    if (actual.sha256 !== member.sha256 || actual.sizeBytes !== member.sizeBytes) {
      throw new Error(`map member ${member.relativePath} digest mismatch: expected ${member.sha256}, got ${actual.sha256}`);
    }
    if (inputs.has(member.inputId)) throw new Error(`duplicate map member input ${member.inputId}`);
    inputs.set(member.inputId, { inputId: member.inputId, path, relativePath: member.relativePath, sha256: member.sha256, sizeBytes: member.sizeBytes });
    verifiedBytes += member.sizeBytes;
    if (verifiedBytes - lastReport >= totalBytes / 20 || verifiedBytes === totalBytes) {
      lastReport = verifiedBytes;
      await progress({ event: "stage.progress", stage: "preparing", completed: verifiedBytes, total: Math.max(1, totalBytes), unit: "bytes" });
    }
  }
  return inputs;
}
