import { NextResponse } from "next/server";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";
import { ReserveLocalNativeArtifactSchema } from "@/app/lib/scenario/jobs/contracts";
import { reserveLocalNativeArtifact } from "@/app/lib/scenario/jobs/local-native-render-store";

type Context = { params: Promise<{ jobId: string }> };

/** Reserves one identity-bound, checksum-bound upload for a leased local native render. */
export async function POST(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ReserveLocalNativeArtifactSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_cpu_job_artifact_reservation", details: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.jobFamily !== "openscenario_render") return NextResponse.json({ error: "invalid_cpu_job_artifact_reservation" }, { status: 400 });
  const { jobId } = await route.params;
  const reservation = await reserveLocalNativeArtifact(jobId, parsed.data);
  return reservation ? NextResponse.json(reservation, { status: 201 }) : NextResponse.json({ error: "lease_invalid_or_expired" }, { status: 409 });
}
