import { NextResponse } from "next/server";
import { readJson, requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { resimulateRevision, revisionMotion, RevisionReplayError, SimulationFailedError } from "@/app/lib/scenario/sim-result-store";
import { SimulationClosureUnavailableError } from "@/app/lib/scenario/sim-closure.server";

type Context = { params: Promise<{ revisionId: string }> };

/**
 * Which motion a revision's renders replay: its active (original) stored
 * result under whatever engine produced it, the other stored results, and
 * whether the legacy OpenSCENARIO replay exists. Never simulates.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { revisionId } = await route.params;
  const motion = await revisionMotion(auth.context.workspaceId, revisionId);
  if (!motion) return NextResponse.json({ error: "revision_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  return NextResponse.json(motion, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}

/**
 * `{ action: "resimulate", waitMs? }`: the explicit "Re-simulate on engine X".
 * Adds a result under the current engine to the revision without changing
 * what renders by default, and returns the motion diff against the active
 * result. Any other body is refused: nothing re-simulates implicitly.
 */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const body = (await readJson(request).catch(() => ({}))) as { action?: unknown; waitMs?: unknown };
  if (body?.action !== "resimulate") {
    return NextResponse.json(
      { error: "explicit_action_required", message: "POST { \"action\": \"resimulate\" } to re-simulate this revision under the current engine." },
      { status: 400, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  }
  const waitMs = typeof body.waitMs === "number" ? Math.max(0, Math.min(25_000, Math.floor(body.waitMs))) : 0;
  const { revisionId } = await route.params;
  try {
    const result = await resimulateRevision(auth.context, revisionId, { waitMs });
    if (!result) return NextResponse.json({ error: "revision_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    const done = result.status.state === "succeeded" || result.status.state === "failed";
    return NextResponse.json(result, { status: done ? 200 : 202, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof RevisionReplayError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    }
    if (error instanceof SimulationClosureUnavailableError || error instanceof SimulationFailedError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 409, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    }
    throw error;
  }
}
