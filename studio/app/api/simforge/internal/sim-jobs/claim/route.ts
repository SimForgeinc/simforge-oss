import { NextResponse } from "next/server";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";
import { ClaimSimulationJobSchema } from "@/app/lib/scenario/contracts";
import { claimSimulationJob } from "@/app/lib/scenario/sim-result-store";

/** A CPU runner claims the oldest queued (or lease-expired) simulation request. */
export async function POST(request: Request) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ClaimSimulationJobSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_sim_job_claim", details: parsed.error.flatten() }, { status: 400 });
  const claim = await claimSimulationJob(parsed.data);
  return claim ? NextResponse.json(claim) : new NextResponse(null, { status: 204 });
}
