import { NextResponse } from "next/server";
import { CompleteScenarioMaterializedTrafficSchema } from "@/app/lib/scenario/contracts";
import { completeMaterializedTraffic } from "@/app/lib/scenario/materialized-traffic-store";
import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ documentId: string }> };
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CompleteScenarioMaterializedTrafficSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_materialized_traffic" }, { status: 400 });
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  const result = await completeMaterializedTraffic(auth.context, documentId, parsed.data);
  return result ? NextResponse.json(result) : NextResponse.json({ error: "materialized_traffic_not_found" }, { status: 404 });
}
