import { NextResponse } from "next/server";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";
import { ReserveSimulationJobSchema } from "@/app/lib/scenario/contracts";
import { reserveSimulationJobOutputs } from "@/app/lib/scenario/sim-result-store";

type Context = { params: Promise<{ requestKey: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ReserveSimulationJobSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_sim_job_reservation", details: parsed.error.flatten() }, { status: 400 });
  const { requestKey } = await route.params;
  const reserved = await reserveSimulationJobOutputs({ ...parsed.data, requestKey });
  return reserved ? NextResponse.json(reserved) : NextResponse.json({ error: "sim_job_lease_lost" }, { status: 409 });
}
