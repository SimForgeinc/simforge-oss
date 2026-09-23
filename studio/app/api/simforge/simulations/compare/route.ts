import { NextResponse } from "next/server";

import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { compareSimulations } from "@/app/lib/scenario/sim-history";
import { versionErrorResponse } from "@/app/lib/scenario/version-http";

const SIM_KEY = /^[a-f0-9]{64}$/;

/** `?base=<simKey>&candidate=<simKey>`: both simulations side by side with their motion diff. */
export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const base = url.searchParams.get("base") ?? "";
  const candidate = url.searchParams.get("candidate") ?? "";
  if (!SIM_KEY.test(base) || !SIM_KEY.test(candidate)) {
    return NextResponse.json({ error: "invalid_sim_key" }, { status: 400, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  }
  try {
    return NextResponse.json(await compareSimulations(auth.context.workspaceId, base, candidate), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    const response = versionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
