import { NextResponse } from "next/server";
import { z } from "zod";

import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { restoreVersionToDraft } from "@/app/lib/scenario/sim-history";
import { versionErrorResponse } from "@/app/lib/scenario/version-http";

type Context = { params: Promise<{ documentId: string; revisionId: string }> };

const RestoreSchema = z.strictObject({ expectedVersion: z.number().int().positive() });

/** Restore a version onto the draft: its content, and its map pin when that differs (explicit re-pin). */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = RestoreSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_restore", details: parsed.error.flatten() }, { status: 400 });
  }
  const { documentId, revisionId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  try {
    const result = await restoreVersionToDraft(auth.context, documentId, revisionId, parsed.data);
    if (result.kind === "not_found") return NextResponse.json({ error: "document_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    if (result.kind === "conflict") {
      return NextResponse.json(
        { error: "draft_version_conflict", refetch: true, currentDraftVersion: result.current.draftVersion, current: result.current },
        { status: 409, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
      );
    }
    return NextResponse.json(result.document, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
