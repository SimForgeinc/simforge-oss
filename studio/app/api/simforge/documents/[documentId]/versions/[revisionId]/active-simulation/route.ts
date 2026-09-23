import { NextResponse } from "next/server";
import { z } from "zod";

import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { selectVersionSimulation } from "@/app/lib/scenario/sim-history";
import { versionErrorResponse } from "@/app/lib/scenario/version-http";

type Context = { params: Promise<{ documentId: string; revisionId: string }> };

const SetActiveSchema = z.strictObject({ simKey: z.string().regex(/^[a-f0-9]{64}$/) });

/** "Use this simulation": the version's renders replay `simKey` (one of its stored results) from now on. */
export async function PUT(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = SetActiveSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_active_simulation", details: parsed.error.flatten() }, { status: 400 });
  }
  const { documentId, revisionId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  try {
    await selectVersionSimulation(auth.context, documentId, revisionId, parsed.data.simKey);
    return NextResponse.json({ ok: true }, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
