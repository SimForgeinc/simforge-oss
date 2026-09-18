import { z, type ZodType } from 'zod';

import {
  ArtifactReservedResponseSchema,
  FencedMutationResponseSchema,
  JobClaimResponseSchema,
  LeaseHeartbeatResponseSchema,
  LeaseProgressResponseSchema,
  RENDER_WORKER_CONTROL_V2_SCHEMA,
  WorkerDrainResponseSchema,
  WorkerRegisteredResponseSchema,
  type ArtifactReserveRequest,
  type ArtifactReservedResponse,
  type FencedMutationResponse,
  type JobClaimRequest,
  type JobClaimResponse,
  type JobCompleteRequest,
  type JobFailRequest,
  type LeaseHeartbeatRequest,
  type LeaseHeartbeatResponse,
  type LeaseProgressRequest,
  type LeaseProgressResponse,
  type WorkerDrainRequest,
  type WorkerDrainResponse,
  type WorkerRegisterRequest,
  type WorkerRegisteredResponse,
} from '@simforge-oss/render';

import type { RenderWorkerConfig } from './config.js';

export interface RenderControlTransport {
  register(request: WorkerRegisterRequest, signal: AbortSignal): Promise<WorkerRegisteredResponse>;
  claim(request: JobClaimRequest, signal: AbortSignal): Promise<JobClaimResponse>;
  heartbeat(request: LeaseHeartbeatRequest, signal: AbortSignal): Promise<LeaseHeartbeatResponse>;
  progress(request: LeaseProgressRequest, signal: AbortSignal): Promise<LeaseProgressResponse>;
  reserveArtifact(request: ArtifactReserveRequest, signal: AbortSignal): Promise<ArtifactReservedResponse>;
  complete(request: JobCompleteRequest, signal: AbortSignal): Promise<FencedMutationResponse>;
  fail(request: JobFailRequest, signal: AbortSignal): Promise<FencedMutationResponse>;
  drain(request: WorkerDrainRequest, signal: AbortSignal): Promise<WorkerDrainResponse>;
  close?(): Promise<void>;
}

export type RenderControlTransportModule = {
  createRenderControlTransport(options: Readonly<Record<string, unknown>>): Promise<RenderControlTransport> | RenderControlTransport;
};

/**
 * Every checked-in Studio worker route lives under this prefix
 * (`studio/app/api/simforge/internal/...`), so the transport addresses the
 * control plane by its real routes rather than a parallel `/v2` surface that
 * was never served.
 */
const INTERNAL_CONTROL_PREFIX = 'api/simforge/internal/';

class HttpRenderControlTransport implements RenderControlTransport {
  private readonly root: URL;
  /**
   * Lease mutations are addressed by job id on the wire
   * (`render-jobs/{jobId}/heartbeat`), while a lease only ever names its lease
   * id and fence token. The claim response is the one place both appear, so
   * the binding is remembered there and dropped once the lease is fenced shut.
   */
  private readonly jobIdByLease = new Map<string, string>();

  constructor(
    baseUrl: URL,
    private readonly workerNodeId: string,
    private readonly headers: Readonly<Record<string, string>>,
    private readonly requestTimeoutMs: number,
  ) {
    // A base URL may carry a mount path; `new URL(relative, base)` only keeps
    // it when the base path ends in a slash.
    this.root = baseUrl.pathname.endsWith('/') ? baseUrl : new URL(`${baseUrl.href}/`);
  }

  private async post<T>(path: string, body: unknown, schema: ZodType<T>, signal: AbortSignal): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const url = new URL(`${INTERNAL_CONTROL_PREFIX}${path}`, this.root);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.headers,
        // The server reads the acting node from this header and refuses any
        // request whose body names a different worker.
        'x-simforge-worker-node-id': this.workerNodeId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, timeoutSignal]),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`render control ${url.pathname} returned ${response.status}: ${text.slice(0, 2048)}`);
    }
    return schema.parse(await response.json());
  }

  private leasePath(leaseId: string, segment: string): string {
    const jobId = this.jobIdByLease.get(leaseId);
    if (!jobId) throw new Error(`lease ${leaseId} was not claimed through this transport`);
    return `render-jobs/${encodeURIComponent(jobId)}/${segment}`;
  }

  register(request: WorkerRegisterRequest, signal: AbortSignal): Promise<WorkerRegisteredResponse> {
    return this.post('workers/register', request, WorkerRegisteredResponseSchema, signal);
  }
  async claim(request: JobClaimRequest, signal: AbortSignal): Promise<JobClaimResponse> {
    const claim = await this.post('render-jobs/lease', request, JobClaimResponseSchema, signal);
    if (claim.type === 'job.leased') this.jobIdByLease.set(claim.lease.leaseId, claim.jobId);
    return claim;
  }
  heartbeat(request: LeaseHeartbeatRequest, signal: AbortSignal): Promise<LeaseHeartbeatResponse> {
    return this.post(this.leasePath(request.leaseId, 'heartbeat'), request, LeaseHeartbeatResponseSchema, signal);
  }
  progress(request: LeaseProgressRequest, signal: AbortSignal): Promise<LeaseProgressResponse> {
    return this.post(this.leasePath(request.leaseId, 'events'), request, LeaseProgressResponseSchema, signal);
  }
  reserveArtifact(request: ArtifactReserveRequest, signal: AbortSignal): Promise<ArtifactReservedResponse> {
    return this.post(this.leasePath(request.leaseId, 'artifacts'), request, ArtifactReservedResponseSchema, signal);
  }
  async complete(request: JobCompleteRequest, signal: AbortSignal): Promise<FencedMutationResponse> {
    const accepted = await this.post(this.leasePath(request.leaseId, 'complete'), request, FencedMutationResponseSchema, signal);
    this.jobIdByLease.delete(request.leaseId);
    return accepted;
  }
  async fail(request: JobFailRequest, signal: AbortSignal): Promise<FencedMutationResponse> {
    const accepted = await this.post(this.leasePath(request.leaseId, 'fail'), request, FencedMutationResponseSchema, signal);
    this.jobIdByLease.delete(request.leaseId);
    return accepted;
  }
  drain(request: WorkerDrainRequest, signal: AbortSignal): Promise<WorkerDrainResponse> {
    return this.post(`workers/${encodeURIComponent(this.workerNodeId)}/state`, request, WorkerDrainResponseSchema, signal);
  }
}

const HttpTransportOptionsSchema = z.strictObject({
  baseUrl: z.url(),
  /**
   * The Studio node identity this worker acts as; the register route rejects a
   * body whose `workerId` disagrees with it.
   */
  workerNodeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  headers: z.record(z.string().min(1), z.string()).default({}),
  requestTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
});

function httpControlTransport(options: z.output<typeof HttpTransportOptionsSchema>): RenderControlTransport {
  const headers: Record<string, string> = { ...options.headers };
  if (options.tokenEnv) {
    const token = process.env[options.tokenEnv];
    if (!token) throw new Error(`control token environment variable ${options.tokenEnv} is not set`);
    headers.authorization = `Bearer ${token}`;
  }
  return new HttpRenderControlTransport(
    new URL(options.baseUrl),
    options.workerNodeId,
    headers,
    options.requestTimeoutMs,
  );
}

/**
 * The module entry point `createControlTransport` loads when
 * `control.kind === 'module'`. Exported so an operator can point a worker at
 * this package instead of hand-writing a transport against the same routes.
 */
export function createRenderControlTransport(
  options: Readonly<Record<string, unknown>>,
): RenderControlTransport {
  return httpControlTransport(HttpTransportOptionsSchema.parse(options));
}

export async function createControlTransport(config: RenderWorkerConfig): Promise<RenderControlTransport> {
  if (config.control.kind === 'http') {
    return httpControlTransport({
      baseUrl: config.control.baseUrl,
      workerNodeId: config.workerId,
      ...(config.control.tokenEnv ? { tokenEnv: config.control.tokenEnv } : {}),
      headers: config.control.headers,
      requestTimeoutMs: config.control.requestTimeoutMs,
    });
  }

  // The module path is operator configuration, so it cannot be a static import.
  const imported = await import(config.control.module) as Partial<RenderControlTransportModule>;
  if (typeof imported.createRenderControlTransport !== 'function') {
    throw new TypeError(`${config.control.module} must export createRenderControlTransport(options)`);
  }
  const transport = await imported.createRenderControlTransport(config.control.options);
  for (const method of ['register', 'claim', 'heartbeat', 'progress', 'reserveArtifact', 'complete', 'fail', 'drain'] as const) {
    if (typeof transport[method] !== 'function') throw new TypeError(`control transport is missing ${method}()`);
  }
  return transport;
}

export { RENDER_WORKER_CONTROL_V2_SCHEMA };
