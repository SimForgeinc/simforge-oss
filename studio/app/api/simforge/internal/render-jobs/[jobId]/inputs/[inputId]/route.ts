import { NextResponse } from "next/server";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { refreshRenderInputV2 } from "@/app/lib/scenario/render-worker-control-store";
import { rejectedLeaseResponse, rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

export async function POST(request: Request, route: { params: Promise<{ jobId: string; inputId: string }> }) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const result = await refreshRenderInputV2({
    ...await route.params,
    workerNodeId: renderWorkerNodeId(request)!,
    leaseId: request.headers.get("x-simforge-lease-id") ?? "",
    fenceToken: request.headers.get("x-simforge-fence-token") ?? "",
  });
  return result ? NextResponse.json(result, { headers: { "cache-control": "no-store" } }) : rejectedLeaseResponse();
}
