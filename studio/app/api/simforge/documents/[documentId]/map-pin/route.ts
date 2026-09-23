import { NextResponse } from "next/server";

import { requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { draftMapPinStatus } from "@/app/lib/scenario/sim-history";

type Context = { params: Promise<{ documentId: string }> };

/**
 * The draft's map pin with the exact descriptor of the pinned version (superseded or retired, so
 * the editor still opens it) and any newer publication the author may explicitly move to.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "read");
  if (access.response) return access.response;
  const status = await draftMapPinStatus(auth.context, documentId);
  return status
    ? NextResponse.json(status, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "document_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
