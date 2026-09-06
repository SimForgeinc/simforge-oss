import { NextResponse } from "next/server";
import {
  ApproveRenderWorkerSchema,
  RevokeRenderWorkerApprovalSchema,
} from "@/app/lib/scenario/contracts";
import {
  approveRenderWorker,
  revokeRenderWorkerApproval,
} from "@/app/lib/scenario/control-plane-store";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";

type Context = { params: Promise<{ workerNodeId: string }> };

async function nodeId(route: Context) {
  const { workerNodeId } = await route.params;
  return workerNodeId && workerNodeId.length <= 200 ? workerNodeId : null;
}

/**
 * Operator-only (fixed local `SIMFORGE_RENDER_WORKER_TOKEN` identity). Pins the
 * identity a node must present to register and opens it for registration.
 * Workers register at `/internal/workers/register` and only succeed when they
 * match this tuple.
 */
export async function PUT(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ApproveRenderWorkerSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_worker_approval", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const workerNodeId = await nodeId(route);
  if (!workerNodeId) return NextResponse.json({ error: "invalid_worker_node_id" }, { status: 400 });
  try {
    const result = await approveRenderWorker(workerNodeId, parsed.data);
    return result
      ? NextResponse.json(result)
      : NextResponse.json({ error: "worker_environment_mismatch" }, { status: 409 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "worker_approval_failed";
    if (code.startsWith("worker_")) return NextResponse.json({ error: code }, { status: 409 });
    throw error;
  }
}

export async function DELETE(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = RevokeRenderWorkerApprovalSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_worker_approval_revocation", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const workerNodeId = await nodeId(route);
  if (!workerNodeId) return NextResponse.json({ error: "invalid_worker_node_id" }, { status: 400 });
  try {
    const result = await revokeRenderWorkerApproval(workerNodeId, parsed.data.reason);
    return result
      ? NextResponse.json(result)
      : NextResponse.json({ error: "approved_worker_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && error.message === "worker_has_active_lease") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
