import { NextResponse } from "next/server";
import { z } from "zod";

import { readJson, requireScenarioContext, requireScenarioMutableDocumentContext } from "@/app/lib/scenario/http";
import { keepPreviousMotion } from "@/app/lib/scenario/sim-history";
import { revisionResultResponse, versionErrorResponse } from "@/app/lib/scenario/version-http";

type Context = { params: Promise<{ documentId: string }> };

const SIM_KEY = z.string().regex(/^[a-f0-9]{64}$/);
const KeepPreviousMotionSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  previousSimKey: SIM_KEY,
  currentSimKey: SIM_KEY,
});

/**
 * "Keep the old motion as a version": after an engine change, freeze the draft into a version that
 * replays the result it showed before (as stored; nothing is simulated with an old engine).
 */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = KeepPreviousMotionSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_keep_previous_motion", details: parsed.error.flatten() }, { status: 400 });
  }
  const { documentId } = await route.params;
  const access = await requireScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  try {
    return revisionResultResponse(await keepPreviousMotion(auth.context, documentId, parsed.data));
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
