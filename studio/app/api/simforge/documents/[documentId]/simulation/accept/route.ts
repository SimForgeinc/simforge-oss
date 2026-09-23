import { NextResponse } from "next/server";
import { z } from "zod";

import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { acceptDraftSimulation } from "@/app/lib/scenario/sim-history";
import { versionErrorResponse } from "@/app/lib/scenario/version-http";

type Context = { params: Promise<{ documentId: string }> };

const AcceptSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  simKey: z.string().regex(/^[a-f0-9]{64}$/),
});

/** After an engine change: the draft moves on with the current engine's motion (dismisses the banner). */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = AcceptSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_accept", details: parsed.error.flatten() }, { status: 400 });
  }
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  try {
    await acceptDraftSimulation(auth.context, documentId, parsed.data);
    return NextResponse.json({ ok: true }, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
