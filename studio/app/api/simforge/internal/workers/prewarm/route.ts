import { NextResponse } from "next/server";
import { PrewarmManifestRequestSchema } from "@simforge-oss/render";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { readJson } from "@/app/lib/scenario/http";
import { approvedRenderWorker, listPrewarmSets } from "@/app/lib/scenario/workers-prewarm-store";
import { rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

/** Published native map closures an approved render worker keeps warm in its cache. */
export async function POST(request: Request) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = PrewarmManifestRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_prewarm_request", details: parsed.error.flatten() }, { status: 400 });
  if (!await approvedRenderWorker(renderWorkerNodeId(request)!)) return NextResponse.json({ error: "worker_not_approved" }, { status: 403 });
  return NextResponse.json(await listPrewarmSets(), { headers: { "cache-control": "no-store" } });
}
