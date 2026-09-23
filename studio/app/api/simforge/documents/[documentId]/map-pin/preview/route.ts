import { NextResponse } from "next/server";
import { z } from "zod";

import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { previewMapRepin } from "@/app/lib/scenario/sim-history";
import { versionErrorResponse } from "@/app/lib/scenario/version-http";

type Context = { params: Promise<{ documentId: string }> };

const PreviewSchema = z.strictObject({
  targetMapVersionId: z.string().trim().min(1).max(200),
  waitMs: z.number().int().min(0).max(25_000).optional(),
});

/** Simulate the draft on another map version and diff it against what it shows now (nothing changes). */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = PreviewSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_repin_preview", details: parsed.error.flatten() }, { status: 400 });
  }
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "read");
  if (access.response) return access.response;
  try {
    const preview = await previewMapRepin(auth.context, documentId, parsed.data);
    if (!preview) return NextResponse.json({ error: "document_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    const done = !preview.status || preview.status.state === "succeeded" || preview.status.state === "failed";
    return NextResponse.json(preview, { status: done ? 200 : 202, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
