import { NextResponse } from "next/server";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";
import { FailSimulationJobSchema } from "@/app/lib/scenario/contracts";
import { failSimulationRequest } from "@/app/lib/scenario/sim-result-store";

type Context = { params: Promise<{ requestKey: string }> };

export async function POST(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = FailSimulationJobSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_sim_job_failure" }, { status: 400 });
  const { requestKey } = await route.params;
  await failSimulationRequest({ ...parsed.data, requestKey });
  return NextResponse.json({ ok: true });
}
