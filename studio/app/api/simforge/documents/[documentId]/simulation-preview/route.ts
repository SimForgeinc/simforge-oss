import { NextResponse } from "next/server";
import { ReserveScenarioSimulationPreviewSchema } from "@/app/lib/scenario/contracts";
import { getCurrentSimulationPreview, reserveSimulationPreview, SimulationPreviewFailed } from "@/app/lib/scenario/simulation-preview-store";
import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { getScenarioDocument } from "@/app/lib/scenario/document-store";
type Context = { params: Promise<{ documentId: string }> };
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  if (!(await getScenarioDocument(auth.context, documentId))) {
    return NextResponse.json({ error: "document_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  }
  try {
    return NextResponse.json(await getCurrentSimulationPreview(auth.context, documentId), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    if (!(error instanceof SimulationPreviewFailed)) throw error;
    return NextResponse.json({ error: "simulation_preview_failed" }, { status: 502, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  }
}
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = ReserveScenarioSimulationPreviewSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_simulation_preview" }, { status: 400 });
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  const value = await reserveSimulationPreview(auth.context, documentId, parsed.data);
  return value ? NextResponse.json(value) : NextResponse.json({ error: "stale_simulation_preview" }, { status: 409 });
}
