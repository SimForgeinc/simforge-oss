import { join } from "node:path";
import { loadBuiltinRenderEngine, type CompletedArtifact, type JobLeasedResponse, type RenderProgressRecord } from "@simforge-oss/render";
import { executeEngine, safeArtifactPath } from "./executor.js";
import { downloadInputs } from "./http-client.js";
import type { RenderControlClient } from "./render-control-client.js";
import type { RemoteInput } from "./types.js";

/**
 * The lease leaves `download` out only for workers that registered lazy input
 * URLs (`labels.inputUrls = "batch-v1"`). This worker does not, so a missing URL
 * is a control-plane contract violation: refuse the claim instead of skipping
 * the input.
 */
export function leasedInputsWithDownloads(claim: Pick<JobLeasedResponse, "jobId" | "inputs">): RemoteInput[] {
  return claim.inputs.map((input) => {
    if (!input.download) {
      throw new Error(`render job ${claim.jobId}: input ${input.inputId} has no download URL; this worker does not sign input URLs lazily`);
    }
    return { ...input, download: input.download };
  });
}

export async function runCarlaClaim(
  client: RenderControlClient,
  claim: JobLeasedResponse,
  workspace: string,
  signal: AbortSignal,
  reportProgress: (record: RenderProgressRecord) => Promise<void>,
): Promise<{ readonly frameCount: number; readonly artifactCount: number }> {
  const progress = (stage: "downloading" | "uploading" | "finalizing", completed: number, total: number) => reportProgress({
    schema: "simforge.render-progress/v1", jobId: claim.jobId, attempt: claim.attempt,
    sequence: 0, timestamp: new Date().toISOString(), event: "stage.progress", stage, completed, total, unit: "items",
  });
  // A surround render runs about eleven minutes; the lease expires in five.
  // Without renewal the plane reclaims the job mid-render, the worker uploads
  // against a dead lease, and the job returns to `queued` having burnt a full
  // GPU pass. The CPU lanes already heartbeat from their own loops; this lane
  // had no equivalent.
  let beats = 0;
  const heartbeat = setInterval(() => {
    beats += 1;
    void client.heartbeat(claim, beats, signal).catch(() => {
      // A failed renewal is not fatal on its own: the lease may still be
      // valid and the next beat can succeed. Losing it surfaces as the
      // fence-token rejection on complete.
    });
  }, 60_000);
  heartbeat.unref?.();
  try {
    await progress("downloading", 0, claim.inputs.length);
    const inputs = await downloadInputs(leasedInputsWithDownloads(claim), join(workspace, "inputs"), signal, client.transfers.hostOrigin);
    await progress("downloading", claim.inputs.length, claim.inputs.length);
    const engine = await loadBuiltinRenderEngine("carla");
    let execution;
    try {
      execution = await executeEngine({
        jobId: claim.jobId, attempt: claim.attempt, engine: "carla", intent: claim.intent,
        intentSha256: claim.intentSha256, executionPackageControlSha256: claim.executionPackageControlSha256,
        inputs, workspace, signal, reportProgress,
      }, engine);
    } finally {
      await engine.close?.();
    }
    const artifacts: CompletedArtifact[] = [];
    const total = execution.runtimeManifest.artifacts.length;
    await progress("uploading", 0, total);
    for (const artifact of execution.runtimeManifest.artifacts) {
      signal.throwIfAborted();
      const reservation = await client.reserve(claim, artifact, signal);
      await client.transfers.uploadNativeArtifact(reservation, safeArtifactPath(workspace, artifact.relativePath), signal);
      const { identity, sha256, sizeBytes, mediaType } = artifact;
      artifacts.push({ artifactId: reservation.artifactId, identity, sha256, sizeBytes, mediaType });
      await progress("uploading", artifacts.length, total);
    }
    await progress("finalizing", 0, 1);
    await client.complete(claim, artifacts, signal);
    return { frameCount: execution.frameCount, artifactCount: artifacts.length };
  } finally {
    clearInterval(heartbeat);
  }
}
