import { NextResponse } from "next/server";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";
import { CompleteSimulationJobSchema } from "@/app/lib/scenario/contracts";
import { completeSimulationRequest, SimulationFailedError } from "@/app/lib/scenario/sim-result-store";

type Context = { params: Promise<{ requestKey: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = CompleteSimulationJobSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_sim_job_completion", details: parsed.error.flatten() }, { status: 400 });
  const { requestKey } = await route.params;
  try {
    const completed = await completeSimulationRequest({
      workspaceId: parsed.data.workspaceId,
      userId: null,
      requestKey,
      fenceToken: parsed.data.fenceToken,
      producer: `cpu:${parsed.data.workerId}`.slice(0, 200),
      completion: parsed.data.completion,
    });
    return NextResponse.json(completed);
  } catch (error) {
    if (error instanceof SimulationFailedError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.code === "simulation_lease_lost" ? 409 : 422 });
    }
    throw error;
  }
}
