import { NextResponse } from "next/server";

import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { resimulateVersion } from "@/app/lib/scenario/sim-history";
import { versionErrorResponse } from "@/app/lib/scenario/version-http";

type Context = { params: Promise<{ documentId: string; revisionId: string }> };

/**
 * "Re-simulate with the current engine": the result joins the version's history with its diff
 * against the active simulation; what the version renders does not change.
 */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const body = (await readJson(request)) as { waitMs?: unknown } | null;
  const waitMs = typeof body?.waitMs === "number" ? Math.max(0, Math.min(25_000, Math.floor(body.waitMs))) : 0;
  const { documentId, revisionId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  try {
    const result = await resimulateVersion(auth.context, documentId, revisionId, { waitMs });
    const done = result.status.state === "succeeded" || result.status.state === "failed";
    return NextResponse.json(result, { status: done ? 200 : 202, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
