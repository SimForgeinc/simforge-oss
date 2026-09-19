import { NextResponse } from "next/server";
import { ScenarioMapResolutionError } from "@simforge-oss/studio-host";
import { ReserveScenarioMaterializedTrafficSchema } from "@/app/lib/scenario/contracts";
import { reserveMaterializedTraffic } from "@/app/lib/scenario/materialized-traffic-store";
import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ documentId: string }> };
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = ReserveScenarioMaterializedTrafficSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_materialized_traffic" }, { status: 400 });
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  let result;
  try {
    result = await reserveMaterializedTraffic(auth.context, documentId, parsed.data);
  } catch (error) {
    if (!(error instanceof ScenarioMapResolutionError)) throw error;
    return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
  }
  return result ? NextResponse.json(result) : NextResponse.json({ error: "stale_materialized_traffic" }, { status: 409 });
}
