import { NextResponse } from "next/server";
import { PrewarmMembersRequestSchema } from "@simforge-oss/render";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { readJson } from "@/app/lib/scenario/http";
import { approvedRenderWorker, listPrewarmMembers } from "@/app/lib/scenario/workers-prewarm-store";
import { rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

/** One page of a published native map closure's members (path, sha256, size). */
export async function POST(request: Request) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = PrewarmMembersRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_prewarm_members_request", details: parsed.error.flatten() }, { status: 400 });
  if (!await approvedRenderWorker(renderWorkerNodeId(request)!)) return NextResponse.json({ error: "worker_not_approved" }, { status: 403 });
  return NextResponse.json(await listPrewarmMembers(parsed.data.setId, parsed.data.after), { headers: { "cache-control": "no-store" } });
}
