import { NextResponse } from "next/server";
import { z } from "zod";

import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { fillMissingMotionDiffs, listDocumentVersions, saveDraftVersion } from "@/app/lib/scenario/sim-history";
import { revisionResultResponse, versionErrorResponse } from "@/app/lib/scenario/version-http";

type Context = { params: Promise<{ documentId: string }> };

/** The document's versions (revisions), newest first, each with its simulation history. */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "read");
  if (access.response) return access.response;
  try {
    // Backfilled history rows get their diff once, the first time anyone looks.
    await fillMissingMotionDiffs(auth.context, documentId);
    const versions = await listDocumentVersions(auth.context, documentId);
    if (!versions) return NextResponse.json({ error: "document_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    return NextResponse.json(versions, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

const SaveVersionSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  label: z.string().trim().min(1).max(120).nullable().optional(),
});

/** "Save version": freeze the draft, simulated under the current engine, as a version. */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = SaveVersionSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_version", details: parsed.error.flatten() }, { status: 400 });
  }
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  try {
    return revisionResultResponse(await saveDraftVersion(auth.context, documentId, parsed.data));
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
