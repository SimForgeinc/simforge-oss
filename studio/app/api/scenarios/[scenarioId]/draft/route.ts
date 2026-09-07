import { NextResponse } from "next/server";
import { queryOne } from "@/app/lib/db/data-api";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

type RouteContext = { params: Promise<{ scenarioId: string }> };

/**
 * The persisted draft JSON of a legacy (variation / AI-proposed) scenario.
 *
 * Map-detail overlays read this to draw the actors of a scenario the map
 * search assistant proposed; the debug download button saves the same
 * document. Scenario documents authored in the editor live in the SimForge
 * scenario API instead (`/api/simforge/documents/...`).
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { scenarioId } = await params;
  const row = await queryOne<{ draft_json: string }>(
    `SELECT draft_json::text AS draft_json
       FROM public.scenarios
      WHERE workspace_id = :workspace_id AND id = :id
      LIMIT 1`,
    { workspace_id: auth.context.workspaceId, id: scenarioId },
  );
  if (!row) return NextResponse.json({ error: "scenario_not_found" }, { status: 404 });
  let draft: unknown;
  try {
    draft = JSON.parse(row.draft_json);
  } catch {
    return NextResponse.json({ error: "scenario_draft_unreadable" }, { status: 500 });
  }
  return NextResponse.json(draft, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
