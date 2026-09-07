import { NextResponse } from "next/server";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";
import { PrepareLocalNativeMapSchema } from "@/app/lib/scenario/jobs/contracts";
import { prepareLocalNativeMap } from "@/app/lib/scenario/jobs/local-native-render-store";

type Context = { params: Promise<{ jobId: string }> };

/**
 * Starts or reports the ensured semantic map for a leased local native
 * render. The worker polls this while it heartbeats; the server owns the
 * map registry, credentials and disk store, so materialization happens here.
 */
export async function POST(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = PrepareLocalNativeMapSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_cpu_job_map_request", details: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.jobFamily !== "openscenario_render") return NextResponse.json({ error: "invalid_cpu_job_map_request" }, { status: 400 });
  const { jobId } = await route.params;
  const preparation = await prepareLocalNativeMap(jobId, parsed.data);
  return preparation ? NextResponse.json(preparation) : NextResponse.json({ error: "lease_invalid_or_expired" }, { status: 409 });
}
