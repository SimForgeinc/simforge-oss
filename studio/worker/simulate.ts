import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import {
  hostTrafficStep,
  loadSimulationMapClosure,
  simulateAuthoritative,
  simulationCompletion,
  stagedSumoRuntime,
  type AuthoritativeSimulation,
  type SimulationMapClosure,
  type SimulationTimeline,
} from "@simforge-oss/compiler/node";
import { PINNED_SUMO_RUNTIME_VERSION, type SumoRuntimeFile } from "@simforge-oss/engine/node";
import { buildRenderTimeline } from "@simforge-oss/render/timeline";

import { simforgeEnv } from "../lib/simforge-env";

/**
 * The CPU runner lane of worker-authoritative simulation for this worker.
 *
 * A host queues a simulation request when it does not execute it inline (a
 * budget, a failure, or `SIMFORGE_SIMULATION_INLINE=0`). This lane claims it
 * under a fenced lease, runs the same `simulateAuthoritative` the host runs
 * inline over the same browser map members the editor loads, derives the
 * render timeline, uploads the content-addressed objects to their checksum-
 * bound reservations and completes. The host verifies every object; a stale
 * completion is refused by the fence.
 */

type JsonObject = Record<string, unknown>;

export type SimulationJobClaim = {
  contract: "simforge.sim-job-claim/v1";
  workspaceId: string;
  requestKey: string;
  fenceToken: string;
  leaseExpiresAt: string;
  contentSha256: string;
  canonicalContent: JsonObject;
  catalogEntries: unknown[];
  map: {
    mapVersionId: string;
    mapAssetId: string;
    browserClosureSha256: string;
    /** `map_versions.sumo_network_sha256`. */
    sumoNetworkSha256?: string | null;
    members: Array<{ relativePath: string; sha256: string; sizeBytes: number; downloadUrl: string }>;
  };
  /** The pinned SUMO runtime, for documents whose traffic is the SUMO step; `null` otherwise. */
  sumoRuntime?: Array<{ file: SumoRuntimeFile; downloadUrl: string }> | null;
};

type Reservation = { uploadRequired: boolean; uploadUrl: string | null; mediaType: string };
type Reservations = { trace: Reservation; resolution: Reservation; traffic: Reservation; timeline?: Reservation };

const DIGEST = /^[a-f0-9]{64}$/;
const REQUIRED_MEMBERS = [
  "3d/manifest.json",
  "topology-index.json.gz",
  "derived/topology-derived.json.gz",
  "derived/locations.json.gz",
  "map.xodr",
  "signals.geojson.gz",
] as const;
/** Scenario errors fail the request for good; everything else is retried by the next claim. */
const SCENARIO_ERROR = /^(template_invalid|materialization_infeasible|semantic_loss|unsupported_portable_semantics|map_bound_|runtime_asset_identity|actor_catalog|simulation_input_identity_mismatch|sumo_network_unavailable)/;

export function parseSimulationJobClaim(value: unknown): SimulationJobClaim {
  const claim = value as SimulationJobClaim;
  if (!claim || claim.contract !== "simforge.sim-job-claim/v1") throw new Error("sim_job_claim_contract_invalid");
  for (const digest of [claim.requestKey, claim.contentSha256, claim.map?.browserClosureSha256]) {
    if (typeof digest !== "string" || !DIGEST.test(digest)) throw new Error("sim_job_claim_digest_invalid");
  }
  if (typeof claim.fenceToken !== "string" || claim.fenceToken.length < 32) throw new Error("sim_job_claim_fence_invalid");
  if (!Array.isArray(claim.map.members) || !claim.canonicalContent || typeof claim.canonicalContent !== "object") {
    throw new Error("sim_job_claim_payload_invalid");
  }
  for (const path of REQUIRED_MEMBERS) {
    if (!claim.map.members.some((member) => member.relativePath === path)) throw new Error(`simulation_map_member_missing:${path}`);
  }
  return claim;
}

/**
 * Resolves the editor loader's member URLs to the claim's presigned,
 * digest-pinned objects. A local host signs root-relative object URLs, which
 * resolve against the host the worker already talks to.
 */
export function claimMemberFetcher(claim: SimulationJobClaim, base: string, hostUrl: URL, fetchImpl: typeof fetch = fetch): typeof fetch {
  const members = new Map(claim.map.members.map((member) => [member.relativePath, member]));
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.href.startsWith(base)) throw new Error(`simulation member outside the claimed closure: ${url.href}`);
    const member = members.get(decodeURIComponent(url.href.slice(base.length)));
    if (!member) return new Response(null, { status: 404 });
    const response = await fetchImpl(new URL(member.downloadUrl, hostUrl), { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) return response;
    // An object store's presigned GET carries no digest header: verify the
    // bytes against the digest the claim pins, then attest it to the loader.
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== member.sha256) {
      throw new Error(`simulation_map_member_digest_mismatch:${member.relativePath}`);
    }
    return new Response(bytes, { status: 200, headers: { "x-content-sha256": member.sha256 } });
  }) as typeof fetch;
}

const closures = new Map<string, Promise<SimulationMapClosure>>();

async function closureFor(claim: SimulationJobClaim, hostUrl: URL, fetchImpl: typeof fetch): Promise<SimulationMapClosure> {
  const key = `${claim.map.mapVersionId}:${claim.map.browserClosureSha256}`;
  const cached = closures.get(key);
  if (cached) return cached;
  const base = `https://simulation-closure.invalid/${encodeURIComponent(key)}/`;
  const digest = (path: string) => claim.map.members.find((member) => member.relativePath === path)!.sha256;
  const loading = loadSimulationMapClosure({
    mapVersionId: claim.map.mapVersionId,
    mapAssetId: claim.map.mapAssetId,
    browserClosureSha256: claim.map.browserClosureSha256,
    sources: {
      manifest: `${base}3d/manifest.json`,
      topology: `${base}topology-index.json.gz`,
      derivedTopology: `${base}derived/topology-derived.json.gz`,
      locations: `${base}derived/locations.json.gz`,
      xodr: `${base}map.xodr`,
      signals: `${base}signals.geojson.gz`,
    },
    digests: {
      topology: digest("topology-index.json.gz"),
      derivedTopology: digest("derived/topology-derived.json.gz"),
      locations: digest("derived/locations.json.gz"),
      xodr: digest("map.xodr"),
      signals: digest("signals.geojson.gz"),
    },
    fetcher: claimMemberFetcher(claim, base, hostUrl, fetchImpl),
  });
  if (closures.size >= 3) closures.delete(closures.keys().next().value!);
  closures.set(key, loading);
  try {
    return await loading;
  } catch (error) {
    closures.delete(key);
    throw error;
  }
}

async function download(url: URL, fetchImpl: typeof fetch, label: string): Promise<Uint8Array> {
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`simulation_member_download_failed:${response.status}:${label}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** A claimed map member, verified against the digest the claim pins. */
async function claimMember(claim: SimulationJobClaim, relativePath: string, hostUrl: URL, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const member = claim.map.members.find((candidate) => candidate.relativePath === relativePath);
  if (!member) throw new Error(`simulation_map_member_missing:${relativePath}`);
  const bytes = await download(new URL(member.downloadUrl, hostUrl), fetchImpl, relativePath);
  if (createHash("sha256").update(bytes).digest("hex") !== member.sha256) {
    throw new Error(`simulation_map_member_digest_mismatch:${relativePath}`);
  }
  return bytes;
}

/** The traffic step a claim runs: the SUMO step for SUMO documents, from the claimed network and runtime. */
export function claimTrafficStep(claim: SimulationJobClaim, hostUrl: URL, fetchImpl: typeof fetch = fetch) {
  return hostTrafficStep(claim.canonicalContent, {
    sumoNetworkSha256: claim.map.sumoNetworkSha256 ?? null,
    readMember: (relativePath) => claimMember(claim, relativePath, hostUrl, fetchImpl),
    runtime: () => stagedSumoRuntime(
      path.join(tmpdir(), "simforge-sumo-runtime", PINNED_SUMO_RUNTIME_VERSION),
      async (file) => {
        const source = claim.sumoRuntime?.find((candidate) => candidate.file === file);
        if (!source) throw new Error(`sumo_runtime_unavailable:${file}`);
        // The runtime is verified against the pinned digests when it loads.
        return download(new URL(source.downloadUrl, hostUrl), fetchImpl, file);
      },
    ),
  });
}

/** Simulate a claim and derive its render timeline, exactly as a host does inline. */
export async function simulateClaim(claim: SimulationJobClaim, hostUrl: URL, fetchImpl: typeof fetch = fetch): Promise<{ simulation: AuthoritativeSimulation; timeline: SimulationTimeline | null }> {
  const closure = await closureFor(claim, hostUrl, fetchImpl);
  const simulation = simulateAuthoritative({
    canonicalContent: claim.canonicalContent,
    closure,
    catalogEntries: claim.catalogEntries as never,
    trafficStep: await claimTrafficStep(claim, hostUrl, fetchImpl),
  });
  let timeline: SimulationTimeline | null = null;
  try {
    timeline = await buildRenderTimeline({ trace: simulation.trace, xodr: closure.xodr, topology: closure.topology, ground: closure.ground, catalogDigest: null });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ component: "simforge-local-simulator", event: "timeline.unavailable", simKey: simulation.simKey, error: error instanceof Error ? error.message : String(error) })}\n`);
  }
  return { simulation, timeline };
}

export class SimulationJobClient {
  constructor(
    readonly baseUrl: URL,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private post(path: string, body: JsonObject): Promise<Response> {
    return this.fetchImpl(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  }

  async claim(workerId: string, leaseSeconds = 300): Promise<SimulationJobClaim | null> {
    const response = await this.post("/api/simforge/internal/sim-jobs/claim", { workerId, leaseSeconds });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`sim_job_claim_failed:${response.status}`);
    return parseSimulationJobClaim(await response.json());
  }

  async reserve(claim: SimulationJobClaim, completion: unknown): Promise<Reservations> {
    const response = await this.post(`/api/simforge/internal/sim-jobs/${claim.requestKey}/reserve`, {
      workspaceId: claim.workspaceId, fenceToken: claim.fenceToken, completion,
    });
    if (response.status === 409) throw new Error("sim_job_lease_lost");
    if (!response.ok) throw new Error(`sim_job_reserve_failed:${response.status}`);
    return await response.json() as Reservations;
  }

  async upload(reservation: Reservation | undefined, bytes: Uint8Array | null, sha256: string | undefined): Promise<void> {
    if (!reservation?.uploadRequired || !bytes || !sha256) return;
    if (!reservation.uploadUrl) throw new Error("sim_job_upload_url_missing");
    // Same-origin local-object reservations are root-relative; presigned object-store URLs are absolute.
    const response = await this.fetchImpl(new URL(reservation.uploadUrl, this.baseUrl), {
      method: "PUT",
      headers: {
        "content-type": reservation.mediaType,
        "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"),
        "x-amz-sdk-checksum-algorithm": "SHA256",
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`sim_job_upload_failed:${response.status}`);
  }

  async complete(claim: SimulationJobClaim, workerId: string, completion: unknown): Promise<void> {
    const response = await this.post(`/api/simforge/internal/sim-jobs/${claim.requestKey}/complete`, {
      workspaceId: claim.workspaceId, fenceToken: claim.fenceToken, workerId, completion,
    });
    if (response.status === 409) throw new Error("sim_job_lease_lost");
    if (!response.ok) throw new Error(`sim_job_complete_failed:${response.status}`);
  }

  async fail(claim: SimulationJobClaim, code: string, message: string, retryable: boolean): Promise<void> {
    const response = await this.post(`/api/simforge/internal/sim-jobs/${claim.requestKey}/fail`, {
      workspaceId: claim.workspaceId, fenceToken: claim.fenceToken, code, message: message.slice(0, 2_000), retryable,
    });
    if (!response.ok && response.status !== 409) throw new Error(`sim_job_fail_callback_failed:${response.status}`);
  }
}

/** Claim and execute one simulation request; false when nothing was queued. */
export async function processSimulationJob(
  client: SimulationJobClient,
  workerId: string,
  simulate: (claim: SimulationJobClaim) => Promise<{ simulation: AuthoritativeSimulation; timeline: SimulationTimeline | null }> = (claim) => simulateClaim(claim, client.baseUrl),
): Promise<boolean> {
  const claim = await client.claim(workerId);
  if (!claim) return false;
  try {
    const { simulation, timeline } = await simulate(claim);
    const { completion, bytes } = simulationCompletion(simulation, timeline);
    const reserved = await client.reserve(claim, completion);
    await client.upload(reserved.trace, bytes.trace, completion.trace.sha256);
    await client.upload(reserved.resolution, bytes.resolution, completion.resolution.sha256);
    await client.upload(reserved.traffic, bytes.traffic, completion.traffic?.sha256);
    await client.upload(reserved.timeline, bytes.timeline, completion.timeline?.timelineSha256);
    await client.complete(claim, workerId, completion);
    process.stdout.write(`${JSON.stringify({ component: "simforge-local-simulator", event: "job.completed", requestKey: claim.requestKey, simKey: completion.simKey, traceSha256: completion.traceSha256 })}\n`);
  } catch (error) {
    if (error instanceof Error && error.message === "sim_job_lease_lost") return true;
    const message = error instanceof Error ? error.message : String(error);
    const head = message.split(":")[0] ?? "";
    const code = /^[a-z0-9_-]{3,100}$/i.test(head) ? head : "simulation_failed";
    await client.fail(claim, code, message, !SCENARIO_ERROR.test(code));
    process.stderr.write(`${JSON.stringify({ component: "simforge-local-simulator", event: "job.failed", requestKey: claim.requestKey, code, error: message.slice(0, 500) })}\n`);
  }
  return true;
}

/** Poll for queued simulation requests until the worker stops. */
export async function runSimulationLoop(baseUrl: string | URL, token: string, signal: AbortSignal): Promise<void> {
  const workerId = simforgeEnv("COMPILER_WORKER_ID")?.trim() || `local-simulator-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-")}-${process.pid}`;
  const pollMs = Math.max(100, Math.min(30_000, Number(simforgeEnv("COMPILER_POLL_MS") ?? 1_000) || 1_000));
  const client = new SimulationJobClient(new URL(baseUrl), token);
  process.stdout.write(`${JSON.stringify({ component: "simforge-local-simulator", event: "worker.started", workerId })}\n`);
  while (!signal.aborted) {
    try {
      if (!(await processSimulationJob(client, workerId))) await wait(pollMs, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      process.stderr.write(`${JSON.stringify({ component: "simforge-local-simulator", event: "claim.retry", error: error instanceof Error ? error.message : String(error) })}\n`);
      await wait(pollMs, undefined, { signal }).catch(() => undefined);
    }
  }
}
