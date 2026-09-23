import { NextResponse } from "next/server";
import { ScenarioMapResolutionError } from "@simforge-oss/studio-host";
import { ResolveScenarioSimulationSchema } from "@/app/lib/scenario/contracts";
import { resolveDocumentSimulation } from "@/app/lib/scenario/document-simulation";
import { readJson, requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { SimulationClosureUnavailableError } from "@/app/lib/scenario/sim-closure.server";

type Context = { params: Promise<{ documentId: string }> };

/**
 * The authoritative simulation of the document's current draft: memoized by
 * content, joined when in flight, executed inline otherwise. The client sends
 * nothing but the draft version it is looking at.
 */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = ResolveScenarioSimulationSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_simulation_request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { documentId } = await route.params;
  try {
    const result = await resolveDocumentSimulation(auth.context, documentId, parsed.data);
    if (result.kind === "not_found") {
      return NextResponse.json({ error: "document_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    }
    if (result.kind === "conflict") {
      return NextResponse.json(
        { error: "draft_version_conflict", currentDraftVersion: result.draftVersion },
        { status: 409, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
      );
    }
    return NextResponse.json(
      { draftVersion: result.draftVersion, ...result.status },
      { status: result.status.state === "succeeded" || result.status.state === "failed" ? 200 : 202, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  } catch (error) {
    if (error instanceof ScenarioMapResolutionError || error instanceof SimulationClosureUnavailableError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 409, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    }
    throw error;
  }
}
