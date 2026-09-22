import { NextResponse } from "next/server";
import { BlobUrlsRequestSchema } from "@simforge-oss/render";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { readJson } from "@/app/lib/scenario/http";
import { approvedRenderWorker, signPrewarmBlobs } from "@/app/lib/scenario/workers-prewarm-store";
import { rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

/** Batch GET URLs for one published native map set's blobs, by digest (up to 500 per call). */
export async function POST(request: Request) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = BlobUrlsRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_blob_urls_request", details: parsed.error.flatten() }, { status: 400 });
  if (!await approvedRenderWorker(renderWorkerNodeId(request)!)) return NextResponse.json({ error: "worker_not_approved" }, { status: 403 });
  return NextResponse.json(await signPrewarmBlobs(parsed.data.setId, parsed.data.sha256s), { headers: { "cache-control": "no-store" } });
}
