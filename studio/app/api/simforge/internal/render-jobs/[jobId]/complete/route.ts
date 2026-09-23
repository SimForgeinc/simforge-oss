import { NextResponse } from "next/server";
import { CompleteRenderJobV2Schema } from "@/app/lib/scenario/render-wire-contracts";
import { renderWorkerNodeId } from "@/app/lib/scenario/control-plane-store";
import { completeRenderJobV2 } from "@/app/lib/scenario/render-worker-control-store";
import { readJson } from "@/app/lib/scenario/http";
import { rejectedLeaseResponse, rejectUnauthorizedRenderWorker } from "@/app/lib/scenario/worker-http";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = await rejectUnauthorizedRenderWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = CompleteRenderJobV2Schema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_completion", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { jobId } = await route.params;
  try {
    const result = await completeRenderJobV2({
      ...parsed.data,
      jobId,
      workerNodeId: renderWorkerNodeId(request)!,
    });
    return result ? NextResponse.json(result) : rejectedLeaseResponse();
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "artifact_verification_failed";
    // The worker only sees the code; the cause belongs in the host log too,
    // or a schema or storage fault is indistinguishable from a bad artifact.
    console.error(`[render-worker] ${jobId}: completion refused (${code})`, error);
    const details = error instanceof Error
      && "verificationDetails" in error
      && typeof error.verificationDetails === "object"
      ? error.verificationDetails
      : undefined;
    return NextResponse.json({ error: code, ...(details ? { details } : {}) }, { status: 409 });
  }
}
