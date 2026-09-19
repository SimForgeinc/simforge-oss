import { join } from "node:path";
import { loadBuiltinRenderEngine, type CompletedArtifact, type JobLeasedResponse, type RenderProgressRecord } from "@simforge-oss/render";
import { executeEngine, safeArtifactPath } from "./executor.js";
import { downloadInputs } from "./http-client.js";
import type { RenderControlClient } from "./render-control-client.js";

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
  await progress("downloading", 0, claim.inputs.length);
  const inputs = await downloadInputs(claim.inputs, join(workspace, "inputs"), signal);
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
}
