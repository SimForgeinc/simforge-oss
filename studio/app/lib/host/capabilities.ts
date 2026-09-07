import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SCENARIO_JOB_FAMILIES,
  SCENARIO_RENDERER_ENGINES,
  STUDIO_HOST_CAPABILITIES_SCHEMA,
  type RenderWorkerCapability,
  type ScenarioRendererEngine,
  type StudioHostCapabilities,
} from "@simforge-oss/studio-host";
import { probeNativeRuntime } from "@simforge-oss/studio-host/node";
import type { AppContext } from "@/app/lib/db/app-context";
import { LOCAL_CLOUD_ROOT } from "@/app/lib/db/config";
import { queryRows } from "@/app/lib/db/data-api";
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

export async function getLocalHostCapabilities(context: AppContext): Promise<StudioHostCapabilities> {
  const [version, fleetWorkers, nativeRuntime] = await Promise.all([
    localStudioVersion(),
    registeredRenderWorkerCapabilities(),
    probeNativeRuntime(),
  ]);
  const localRender = localRenderCapability();
  return {
    schema: STUDIO_HOST_CAPABILITIES_SCHEMA,
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
      renderWorkers: { ...fleetWorkers, ...localRenderWorkers(localRender) },
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
