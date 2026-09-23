import { NextResponse } from "next/server";
import { InputUrlsRequestSchema } from "@simforge-oss/render";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { readJson } from "@/app/lib/scenario/http";
import { signRenderInputsV2 } from "@/app/lib/scenario/render-worker-control-store";
import { rejectedLeaseResponse, rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

/**
 * Batch download URLs for a live lease's inputs. A worker that registered
 * `inputUrls: batch-v1` receives leases without per-input URLs and asks here
 * only for the inputs its content-addressed cache is missing.
 */
export async function POST(request: Request, route: { params: Promise<{ jobId: string }> }) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = InputUrlsRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input_urls_request", details: parsed.error.flatten() }, { status: 400 });
  const result = await signRenderInputsV2({
    jobId: (await route.params).jobId,
    workerNodeId: renderWorkerNodeId(request)!,
    leaseId: parsed.data.leaseId,
    fenceToken: parsed.data.fenceToken,
    inputIds: parsed.data.inputIds,
  });
  return result ? NextResponse.json(result, { headers: { "cache-control": "no-store" } }) : rejectedLeaseResponse();
}
