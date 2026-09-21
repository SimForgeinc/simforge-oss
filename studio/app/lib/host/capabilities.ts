import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SCENARIO_JOB_FAMILIES,
  SCENARIO_RENDERER_ENGINES,
  STUDIO_HOST_CAPABILITIES_SCHEMA,
  STUDIO_HOST_PROTOCOL_VERSION,
  STUDIO_HOST_TRANSPORTS,
  type RenderWorkerCapability,
  type ScenarioRendererEngine,
  type StudioHostCapabilities,
  type StudioWorkerNode,
} from "@simforge-oss/studio-host";
import { probeNativeRuntime } from "@simforge-oss/studio-host/node";
import type { AppContext } from "@/app/lib/db/app-context";
import { LOCAL_CLOUD_ROOT } from "@/app/lib/db/config";
import { queryRows } from "@/app/lib/db/data-api";
import { liveCpuWorkers } from "@/app/lib/scenario/jobs/local-native-render-store";
import { localRenderCapability, localRenderWorkers } from "./local-render";

const HEARTBEAT_WINDOW = "90 seconds";
let studioVersion: string | null | undefined;

async function localStudioVersion(): Promise<string | null> {
  if (studioVersion !== undefined) return studioVersion;
  try {
    const manifest: unknown = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    studioVersion = manifest !== null && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string"
      ? manifest.version
      : null;
  } catch {
    studioVersion = null;
  }
  return studioVersion;
}

/**
 * Engines with an approved, recently heartbeating, non-draining fleet worker
 * registered against this host. Same eligibility predicate the V2 claim path
 * applies. Engines without any registered node are omitted: a local host does
 * not offer them, and its own lanes are reported separately.
 */
async function registeredRenderWorkerCapabilities(): Promise<Partial<Record<ScenarioRendererEngine, RenderWorkerCapability>>> {
  const environment = process.env.SIMFORGE_ENV?.trim() ?? "dev";
  const rows = await queryRows<{ renderer_engine: ScenarioRendererEngine; ready: number | string }>(
    `SELECT renderer_engine,
            count(*) FILTER (
              WHERE registration_state = 'active'
                AND last_heartbeat_at >= NOW() - INTERVAL '${HEARTBEAT_WINDOW}'
                AND approved_worker_version = worker_version
                AND approved_image_digest = image_digest
                AND approved_hardware_profile = hardware_profile
                AND approved_at IS NOT NULL
            ) AS ready
       FROM simforge.worker_nodes
      WHERE environment = :environment
      GROUP BY renderer_engine`,
    { environment },
  );
  const result: Partial<Record<ScenarioRendererEngine, RenderWorkerCapability>> = {};
  for (const row of rows) {
    if (!SCENARIO_RENDERER_ENGINES.includes(row.renderer_engine)) continue;
    result[row.renderer_engine] = Number(row.ready) > 0
      ? { available: true, reason: null }
      : { available: false, reason: `No approved ${row.renderer_engine} render worker has heartbeated within ${HEARTBEAT_WINDOW}.` };
  }
  return result;
}
async function registeredWorkerNodes(): Promise<StudioWorkerNode[]> {
  const environment = process.env.SIMFORGE_ENV?.trim() ?? "dev";
  const rows = await queryRows<{
    id: string;
    renderer_engine: string | null;
    capabilities: string | Record<string, unknown> | null;
    last_heartbeat_at: string | null;
  }>(
    `SELECT id, renderer_engine, capabilities::text AS capabilities, last_heartbeat_at::text AS last_heartbeat_at
       FROM simforge.worker_nodes
      WHERE environment = :environment
      ORDER BY id`,
    { environment },
  );
  const nodes = rows.map((row) => ({
    id: row.id,
    engines: row.renderer_engine ? [row.renderer_engine] : [],
    capabilities: typeof row.capabilities === "string"
      ? JSON.parse(row.capabilities)
      : row.capabilities ?? {},
    lastHeartbeatAt: row.last_heartbeat_at,
  }));
  const known = new Set(nodes.map((node) => node.id));
  for (const worker of await liveCpuWorkers()) {
    if (known.has(worker.workerId)) continue;
    nodes.push({
      id: worker.workerId,
      engines: [...worker.engines],
      capabilities: [...worker.engines],
      lastHeartbeatAt: worker.lastSeenAt,
    });
  }
  return nodes;
}

export async function getLocalHostCapabilities(context: AppContext): Promise<StudioHostCapabilities> {
  const [version, fleetWorkers, nativeRuntime, workerNodes, localRender] = await Promise.all([
    localStudioVersion(),
    registeredRenderWorkerCapabilities(),
    probeNativeRuntime(),
    registeredWorkerNodes(),
    localRenderCapability(),
  ]);
  return {
    schema: STUDIO_HOST_CAPABILITIES_SCHEMA,
    protocolVersion: STUDIO_HOST_PROTOCOL_VERSION,
    transports: STUDIO_HOST_TRANSPORTS,
    host: { kind: "local", label: "SimForge Studio (local)", version },
    identity: {
      mode: "fixed-local",
      userId: context.userId,
      workspaceId: context.workspaceId,
      organizationId: context.organizationId,
      displayName: context.session.name,
    },
    persistence: { kind: "pglite-filesystem", dataRoot: LOCAL_CLOUD_ROOT },
    execution: {
      browserSimulation: true,
      // Registered fleet nodes (if any were approved against this host) first, then this
      // machine's own lanes, which are the truth for a local install.
      workerNodes,
      renderWorkers: { ...fleetWorkers, ...(await localRenderWorkers(localRender)) },
      nativeRuntime,
      localRender,
    },
    jobs: {
      families: SCENARIO_JOB_FAMILIES,
      // The shell stops the host it started when the window closes; leased jobs are then
      // requeued by lease expiry, which is retry, not uninterrupted execution. Only a
      // launcher that detaches the host as a service may claim otherwise.
      survivesUiClose: process.env.SIMFORGE_LOCAL_HOST_LIFETIME?.trim() === "service",
    },
  };
}
