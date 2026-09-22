import { NextResponse } from "next/server";
import { WorkerCacheReportRequestSchema } from "@simforge-oss/render";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { readJson } from "@/app/lib/scenario/http";
import { recordWorkerCacheStatus } from "@/app/lib/scenario/workers-prewarm-store";
import { rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

type Context = { params: Promise<{ workerNodeId: string }> };

/** A worker's cache/prewarm readiness (maps ready X/Y, bytes), kept on its node row for ops and the UI. */
export async function POST(request: Request, route: Context) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = WorkerCacheReportRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_worker_cache_status", details: parsed.error.flatten() }, { status: 400 });
  const { workerNodeId } = await route.params;
  if (renderWorkerNodeId(request) !== workerNodeId) return NextResponse.json({ error: "worker_node_identity_mismatch" }, { status: 409 });
  const recorded = await recordWorkerCacheStatus(workerNodeId, parsed.data.registrationId, parsed.data.cache);
  return recorded ? NextResponse.json(recorded) : NextResponse.json({ error: "worker_not_found" }, { status: 404 });
}
