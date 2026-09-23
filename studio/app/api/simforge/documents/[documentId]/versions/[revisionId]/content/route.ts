import { NextResponse } from "next/server";

import { requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { readVersionContent } from "@/app/lib/scenario/sim-history";
import { versionErrorResponse } from "@/app/lib/scenario/version-http";

type Context = { params: Promise<{ documentId: string; revisionId: string }> };

/** A version's frozen content, for "Restore this version to the draft". */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId, revisionId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "read");
  if (access.response) return access.response;
  try {
    return NextResponse.json(await readVersionContent(auth.context, documentId, revisionId), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
