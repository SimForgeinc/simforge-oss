import { NextResponse } from "next/server";
import {
  completeLocalStudioSetup,
  isStudioSetupMode,
  isStudioSetupQuality,
  readLocalStudioSetup,
} from "@/app/lib/host/setup-store";
import { readJson, requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** Whether this installation has finished first-run setup, and how it finished. */
export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(await readLocalStudioSetup(), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}

/** Completes first-run setup with the mode and graphics level the user chose. */
export async function PUT(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const body = (await readJson(request)) as { mode?: unknown; quality?: unknown } | null;
  if (!isStudioSetupMode(body?.mode) || !isStudioSetupQuality(body?.quality)) {
    return NextResponse.json({ error: "invalid_setup" }, { status: 400 });
  }
  const setup = await completeLocalStudioSetup({ mode: body.mode, quality: body.quality });
  return NextResponse.json(setup, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
