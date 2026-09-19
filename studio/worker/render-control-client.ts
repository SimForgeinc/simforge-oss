import {
  RENDER_WORKER_CONTROL_V2_SCHEMA as schema,
  WorkerRegisterRequestSchema, WorkerRegisteredResponseSchema,
  JobClaimRequestSchema, JobClaimResponseSchema,
  LeaseHeartbeatRequestSchema, LeaseHeartbeatResponseSchema,
  LeaseProgressRequestSchema, LeaseProgressResponseSchema,
  ArtifactReserveRequestSchema, ArtifactReservedResponseSchema,
  JobCompleteRequestSchema, JobFailRequestSchema, FencedMutationResponseSchema,
  type EngineCapabilityDeclaration, type JobLeasedResponse, type RenderProgressRecord,
  type ArtifactManifestEntry, type CompletedArtifact,
} from "@simforge-oss/render";
import type { CpuJobsClient } from "./http-client.js";

/** CARLA's control-v2 transport; the CPU-job lanes retain their own protocol. */
export class RenderControlClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
    readonly workerId: string,
    readonly transfers: Pick<CpuJobsClient, "uploadNativeArtifact">,
  ) {}

  private async request<T>(path: string, body: unknown, responseSchema: { parse(value: unknown): T }, signal: AbortSignal): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        // The plane resolves the credential from the token *and* this header
        // (control-plane-store.ts:155-165); without it every worker route
        // answers 401 worker_credential_missing.
        "x-simforge-worker-node-id": this.workerId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error(`render control ${path} returned ${response.status}: ${(await response.text()).slice(0, 2048)}`);
    const value: unknown = await response.json();
    // The deployed render-worker-control-store.ts:30 still emits this pre-rename namespace.
    if (value !== null && typeof value === "object" && "schema" in value && value.schema === "uniscenario.render-worker-control/v2") {
      return responseSchema.parse({ ...value, schema });
    }
    return responseSchema.parse(value);
  }

  /**
   * The plane requires hardwareProfile, gpuModel and gpuMemoryMiB labels plus
   * an image or code digest, and rejects the registration by name when one is
   * missing (`worker_label_<key>_required`,
   * render-worker-control-store.ts:47-74). They describe the machine, so they
   * come from its environment rather than being guessed here.
   */
  register(engine: EngineCapabilityDeclaration, instanceId: string, labels: Record<string, string>, signal: AbortSignal) {
    return this.request("/api/simforge/internal/workers/register", WorkerRegisterRequestSchema.parse({
      schema, type: "worker.register", workerId: this.workerId, instanceId, engine, labels,
    }), WorkerRegisteredResponseSchema, signal);
  }

  claim(registrationId: string, signal: AbortSignal) {
    return this.request("/api/simforge/internal/render-jobs/lease", JobClaimRequestSchema.parse({
      schema, type: "job.claim", registrationId,
    }), JobClaimResponseSchema, signal);
  }

  heartbeat(claim: JobLeasedResponse, progressSequence: number, signal: AbortSignal) {
    return this.request(`/api/simforge/internal/render-jobs/${encodeURIComponent(claim.jobId)}/heartbeat`, LeaseHeartbeatRequestSchema.parse({
      schema, type: "lease.heartbeat", leaseId: claim.lease.leaseId, fenceToken: claim.lease.fenceToken, progressSequence,
    }), LeaseHeartbeatResponseSchema, signal);
  }

  progress(claim: JobLeasedResponse, records: RenderProgressRecord[], signal: AbortSignal) {
    return this.request(`/api/simforge/internal/render-jobs/${encodeURIComponent(claim.jobId)}/events`, LeaseProgressRequestSchema.parse({
      schema, type: "lease.progress", leaseId: claim.lease.leaseId, fenceToken: claim.lease.fenceToken, records,
    }), LeaseProgressResponseSchema, signal);
  }

  reserve(claim: JobLeasedResponse, artifact: ArtifactManifestEntry, signal: AbortSignal) {
    const { identity, sha256, sizeBytes, mediaType } = artifact;
    return this.request(`/api/simforge/internal/render-jobs/${encodeURIComponent(claim.jobId)}/artifacts`, ArtifactReserveRequestSchema.parse({
      schema, type: "artifact.reserve", leaseId: claim.lease.leaseId, fenceToken: claim.lease.fenceToken,
      identity, sha256, sizeBytes, mediaType,
    }), ArtifactReservedResponseSchema, signal);
  }

  complete(claim: JobLeasedResponse, artifacts: CompletedArtifact[], signal: AbortSignal) {
    return this.request(`/api/simforge/internal/render-jobs/${encodeURIComponent(claim.jobId)}/complete`, JobCompleteRequestSchema.parse({
      schema, type: "job.complete", leaseId: claim.lease.leaseId, fenceToken: claim.lease.fenceToken,
      intentSha256: claim.intentSha256, manifest: { artifacts },
    }), FencedMutationResponseSchema, signal);
  }

  fail(claim: JobLeasedResponse, error: unknown, signal: AbortSignal) {
    return this.request(`/api/simforge/internal/render-jobs/${encodeURIComponent(claim.jobId)}/fail`, JobFailRequestSchema.parse({
      schema, type: "job.fail", leaseId: claim.lease.leaseId, fenceToken: claim.lease.fenceToken,
      intentSha256: claim.intentSha256,
      failure: { code: "render_execution_failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 8192) || "Render failed", retryable: false },
    }), FencedMutationResponseSchema, signal);
  }
}
