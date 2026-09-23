import { NextResponse } from "next/server";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { getSimulationResult } from "@/app/lib/scenario/sim-result-store";

type Context = { params: Promise<{ simKey: string }> };

/** One immutable authoritative result by key (the trace URL is presigned, so the response is private). */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { simKey } = await route.params;
  if (!/^[a-f0-9]{64}$/.test(simKey)) return NextResponse.json({ error: "invalid_sim_key" }, { status: 400 });
  const result = await getSimulationResult(auth.context.workspaceId, simKey);
  return result
    ? NextResponse.json(result, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "simulation_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
