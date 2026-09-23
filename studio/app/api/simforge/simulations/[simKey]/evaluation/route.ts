import { NextResponse } from "next/server";
import { readJson, requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { evaluateSimulationResult } from "@/app/lib/scenario/sim-result-store";

type Context = { params: Promise<{ simKey: string }> };

/**
 * Evaluate the authoritative trace by key (optionally filtered). Evaluation
 * never re-simulates: it grades the same trace every render replays.
 */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { simKey } = await route.params;
  if (!/^[a-f0-9]{64}$/.test(simKey)) return NextResponse.json({ error: "invalid_sim_key" }, { status: 400 });
  const body = (await readJson(request).catch(() => ({}))) as { filters?: unknown };
  const filters = body && typeof body.filters === "object" && body.filters !== null ? body.filters as Record<string, unknown> : {};
  const evaluated = await evaluateSimulationResult(auth.context.workspaceId, simKey, filters);
  return evaluated
    ? NextResponse.json(evaluated, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "simulation_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
