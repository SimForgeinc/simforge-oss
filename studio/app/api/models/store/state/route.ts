import { NextResponse } from "next/server";
import { allInstallStates, stateGeneration } from "@simforge-oss/model-store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/**
 * The install slice alone — the endpoint a client polls at ~1 s while any
 * install is in a non-terminal state.
 *
 * Polling rather than a stream is deliberate: install progress is durable on
 * disk (`install.json` plus `<file>.part`), so a poll is restart-safe and
 * needs no stream lifecycle to reconcile after the app is closed mid-download.
 * `generation` increments on every observable change, so a client can skip
 * re-rendering when nothing moved.
 */
export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    { installs: await allInstallStates(), generation: stateGeneration() },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
