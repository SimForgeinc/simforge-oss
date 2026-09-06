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
 * Which render engines have an approved, recently heartbeating, non-draining
 * worker registered right now. Same eligibility predicate the V2 claim path
 * applies, minus the per-intent resource fit that only a concrete job answers.
 */
async function renderWorkerCapabilities(): Promise<Record<ScenarioRendererEngine, RenderWorkerCapability>> {
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
  const byEngine = new Map(rows.map((row) => [row.renderer_engine, Number(row.ready)]));
  const result = {} as Record<ScenarioRendererEngine, RenderWorkerCapability>;
  for (const engine of SCENARIO_RENDERER_ENGINES) {
    const ready = byEngine.get(engine) ?? 0;
    result[engine] = ready > 0
      ? { available: true, reason: null }
      : {
          available: false,
          reason: byEngine.has(engine)
            ? `No approved ${engine} render worker has heartbeated within ${HEARTBEAT_WINDOW}.`
            : `No ${engine} render worker is registered with this host.`,
        };
  }
  return result;
}

export async function getLocalHostCapabilities(context: AppContext): Promise<StudioHostCapabilities> {
  const [version, renderWorkers, nativeRuntime] = await Promise.all([
    localStudioVersion(),
    renderWorkerCapabilities(),
    probeNativeRuntime(),
  ]);
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
      renderWorkers,
      nativeRuntime,
    },
    jobs: {
      families: SCENARIO_JOB_FAMILIES,
      survivesUiClose: true,
    },
  };
}
