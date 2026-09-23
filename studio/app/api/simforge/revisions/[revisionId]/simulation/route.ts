import { NextResponse } from "next/server";
import { readJson, requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { resolveRevisionSimulation } from "@/app/lib/scenario/sim-result-store";
import { SimulationClosureUnavailableError } from "@/app/lib/scenario/sim-closure.server";

type Context = { params: Promise<{ revisionId: string }> };

async function respond(revisionId: string, context: { workspaceId: string; userId: string | null }, waitMs: number) {
  try {
    const status = await resolveRevisionSimulation(context, revisionId, { waitMs });
    if (!status) return NextResponse.json({ error: "revision_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    return NextResponse.json(status, {
      status: status.state === "succeeded" || status.state === "failed" ? 200 : 202,
      headers: SCENARIO_PRIVATE_CACHE_HEADERS,
    });
  } catch (error) {
    if (error instanceof SimulationClosureUnavailableError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 409, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    }
    throw error;
  }
}

/**
 * The authoritative simulation a revision renders and is evaluated against,
 * under the current engine semantics. Revisions committed before this
 * pipeline (or under another engine) are simulated lazily on first request
 * and report `resimulated: true`.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { revisionId } = await route.params;
  return respond(revisionId, auth.context, 0);
}

export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const body = (await readJson(request).catch(() => ({}))) as { waitMs?: unknown };
  const waitMs = typeof body?.waitMs === "number" ? Math.max(0, Math.min(25_000, Math.floor(body.waitMs))) : 0;
  const { revisionId } = await route.params;
  return respond(revisionId, auth.context, waitMs);
}
