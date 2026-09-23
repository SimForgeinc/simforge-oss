import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { RenderInputError, type RenderInputFile, type RenderProgressRecord } from "@simforge-oss/render";
import { assertSafeNativeMapMemberPath, createRenderEngine } from "@simforge-oss/render/native";

import { executeEngine, safeArtifactPath } from "./executor.js";
import { downloadInputs, downloadVerified, type CpuJobsClient } from "./http-client.js";
import type {
  CpuJobClaim,
  EngineExecution,
  NativeArtifactIdentity,
  NativeCompletionArtifact,
  NativeMapMember,
  NativeMapMemberSource,
  NativeMapPreparation,
  NativeRenderClaimPayload,
} from "./types.js";

/**
 * The local native (Bevy) render lane of the worker.
 *
 * Small immutable inputs (OpenSCENARIO, OpenDRIVE, catalog, actor closure)
 * are fetched per attempt and hashed. The map's closure is fetched the same
 * way, from the checksum-bound URL the host issues per member, through a
 * content-addressed cache this worker owns; this lane then proves every
 * declared member's bytes in place before the engine sees the directory.
 * Nothing here reads a host path, which is what lets the lane run on another
 * machine. Outputs are reserved one identity at a time, streamed to the
 * object store, and completed with the engine's own evidence so the host can
 * fence success on it.
 */

const MAP_POLL_MS = 2_000;
/** Hundreds of small resources per closure: enough sockets to fill the link, few enough to stay polite. */
const MAP_DOWNLOAD_CONCURRENCY = 8;
const SHA256 = /^[a-f0-9]{64}$/u;
export type NativeRenderOutcome = { readonly frameCount: number; readonly artifactCount: number };

type StageProgress = Extract<RenderProgressRecord, { event: "stage.progress" }>;
export type StageProgressReporter = (record: Pick<StageProgress, "stage" | "completed" | "total" | "unit">) => Promise<void>;

export async function runNativeClaim(
  client: CpuJobsClient,
  claim: CpuJobClaim & { readonly payload: NativeRenderClaimPayload },
  workspace: string,
  /** Content-addressed closure cache shared by every attempt on this worker. */
  mapCacheRoot: string,
  signal: AbortSignal,
  reportProgress: (record: RenderProgressRecord) => Promise<void>,
): Promise<NativeRenderOutcome> {
  const { payload } = claim;
  if (!payload.intent.renderTextures) throw new Error("native_render_texture_profile_missing");
  if (!payload.intent.nativeVramBudgetBytes && !payload.intent.nativeVramCapacityBytes) throw new Error("native_vram_capacity_missing");
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
  const fetched = await downloadInputs(payload.inputs, join(workspace, "inputs"), signal, client.hostOrigin);
  await progress({ stage: "downloading", completed: payload.inputs.length, total: payload.inputs.length, unit: "items" });

  const prepared = await awaitPreparedMap(client, claim, signal, progress);
  const directory = join(workspace, "map");
  await materializeMapClosure({
    members: payload.map.members,
    sources: prepared.members,
    directory,
    cacheRoot: mapCacheRoot,
    hostOrigin: client.hostOrigin,
    signal,
    progress,
  });
  const mapInputs = await verifyMapClosure(directory, payload.map.members, signal, progress);
  const inputs = new Map<string, RenderInputFile>([...fetched, ...mapInputs]);

  const engine = createRenderEngine({ nativeCacheDirectory: process.env.SIMFORGE_NATIVE_CACHE_DIR });
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

  // No engine warning is silently discarded (docs/engineering/no-silent-fallbacks.md):
  // each becomes a job event the host shows with the render, and one that
  // cannot be recorded fails the job rather than vanishing.
  for (const warning of execution.runtimeManifest.warnings) {
    await client.event(claim, "warning", { code: warning.code, message: warning.message.slice(0, 2_000) }, signal);
  }

  // The native engine reports degraded output by failing, never by a warning
  // (docs/engineering/no-silent-fallbacks.md); a warning here is an engine
  // that did not, and its output is not uploaded as a final render.
  const warnings = execution.runtimeManifest.warnings;
  if (warnings.length > 0) {
    throw new RenderInputError("native_render_degraded", `the native engine reported degraded output: ${warnings.map((warning) => `${warning.code}: ${warning.message}`).join("; ")}`);
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
): Promise<Extract<NativeMapPreparation, { state: "ready" }>> {
  const started = Date.now();
  for (;;) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("native render aborted");
    const preparation = await client.prepareMap(claim, signal);
    if (preparation.state === "ready") return preparation;
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

/**
 * One member's bytes in this worker's content-addressed cache, downloaded
 * from the host's URL when the cache does not hold them. Repeated jobs on the
 * same map therefore cost one closure download per worker, not per attempt.
 *
 * A cache hit is trusted on size alone here; every byte is digested again
 * from the attempt's own directory by {@link verifyMapClosure} before the
 * engine sees it, so a corrupted entry fails the attempt rather than
 * rendering a map that is not the intent's.
 */
async function cachedMember(
  member: NativeMapMemberSource,
  cacheRoot: string,
  hostOrigin: string,
  signal: AbortSignal,
): Promise<string> {
  if (!SHA256.test(member.sha256)) throw new Error(`map member ${member.relativePath} has no sha256 digest`);
  const directory = join(cacheRoot, "sha256", member.sha256.slice(0, 2));
  const path = join(directory, member.sha256);
  const cached = await stat(path).catch(() => null);
  if (cached?.isFile() && cached.size === member.sizeBytes) return path;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A partial download must never be mistaken for the object it is named
  // after, so the bytes are verified under a private name and published by
  // rename, which is atomic against every other attempt on this worker.
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    await downloadVerified(member, temporary, signal, hostOrigin);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return path;
}

/** Filesystems without hard links (or a cache on another device) cost a copy, not a failure. */
const COPY_INSTEAD: Record<string, true> = { EXDEV: true, EPERM: true, EMLINK: true, ENOSYS: true, EOPNOTSUPP: true };

/**
 * Materializes the declared closure under `directory` from the host's
 * per-member downloads. The declaration drives it: a member the preparation
 * does not offer, or offers with other bytes, fails here rather than after
 * hundreds of megabytes have moved, and nothing undeclared is ever written.
 */
export async function materializeMapClosure(input: {
  readonly members: readonly NativeMapMember[];
  readonly sources: readonly NativeMapMemberSource[];
  readonly directory: string;
  readonly cacheRoot: string;
  readonly hostOrigin: string;
  readonly signal: AbortSignal;
  readonly progress: StageProgressReporter;
}): Promise<void> {
  const { members, directory, cacheRoot, hostOrigin, signal, progress } = input;
  const offered = new Map(input.sources.map((source) => [source.inputId, source]));
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const targets = members.map((member) => {
    assertSafeNativeMapMemberPath(member.relativePath);
    const path = resolve(root, member.relativePath);
    if (path === root || !path.startsWith(`${root}${sep}`)) {
      throw new Error(`map member escapes the map directory: ${member.relativePath}`);
    }
    const source = offered.get(member.inputId);
    if (!source) throw new Error(`map preparation offers no download for member ${member.inputId}`);
    if (source.sha256 !== member.sha256 || source.sizeBytes !== member.sizeBytes || source.relativePath !== member.relativePath) {
      throw new Error(`map preparation offers member ${member.inputId} with bytes the intent does not declare`);
    }
    return { source, path };
  });
  if (new Set(targets.map((target) => target.path)).size !== targets.length) {
    throw new Error("map closure declares the same relative path twice");
  }

  const totalBytes = Math.max(1, members.reduce((sum, member) => sum + member.sizeBytes, 0));
  let readyBytes = 0;
  let reportedBytes = 0;
  let next = 0;
  const materialize = async (): Promise<void> => {
    for (let index = next++; index < targets.length; index = next++) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("native render aborted");
      const { source, path } = targets[index]!;
      const cached = await cachedMember(source, cacheRoot, hostOrigin, signal);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await link(cached, path).catch(async (error: unknown) => {
        if (COPY_INSTEAD[(error as NodeJS.ErrnoException).code ?? ""] !== true) throw error;
        await copyFile(cached, path);
      });
      readyBytes += source.sizeBytes;
      if (readyBytes - reportedBytes >= totalBytes / 20 || readyBytes >= totalBytes) {
        reportedBytes = readyBytes;
        await progress({ stage: "preparing", completed: readyBytes, total: totalBytes, unit: "bytes" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAP_DOWNLOAD_CONCURRENCY, targets.length) }, materialize));
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
 * Proves the materialized directory holds exactly the intent's declared
 * closure: every member at its closure-relative path with the declared
 * sha256 and size. The directory is used in place afterwards, so this is the
 * only point at which its bytes — whether just downloaded or reused from the
 * worker's cache — are bound to the intent.
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
