import { NextResponse } from "next/server";
import { z } from "zod";

import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { moveDraftToMapVersion } from "@/app/lib/scenario/sim-history";
import { revisionResultResponse, versionErrorResponse } from "@/app/lib/scenario/version-http";

type Context = { params: Promise<{ documentId: string }> };

const MoveSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  targetMapVersionId: z.string().trim().min(1).max(200),
});

/**
 * "Move to new map version": saves the draft as it is (a `map_move` version with its map pin and
 * simulation) and then moves it to the planned content on the new version. A blocked plan, or a
 * before that cannot be saved, moves nothing.
 */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = MoveSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_map_move", details: parsed.error.flatten() }, { status: 400 });
  }
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  try {
    const result = await moveDraftToMapVersion(auth.context, documentId, parsed.data);
    switch (result.kind) {
      case "moved":
        return NextResponse.json({ document: result.document, before: result.before, plan: result.plan }, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
      case "blocked":
        return NextResponse.json(
          { error: result.plan.blocking?.code ?? "map_move_blocked", message: result.plan.blocking?.message ?? "The move is blocked.", plan: result.plan },
          { status: 409, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
        );
      default:
        return revisionResultResponse(result);
    }
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
