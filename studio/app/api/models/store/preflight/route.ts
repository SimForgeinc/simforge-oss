import { NextResponse } from "next/server";
import { preflight, type ModelFamilyId } from "@simforge-oss/model-store";
import { MODEL_FAMILIES } from "@simforge-oss/model-store/catalog";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/**
 * `simforge.model-preflight/v1` on its own, for refreshing the eligibility
 * panel without re-sending the catalog and install state.
 *
 * `?reserveRenderer=1` asks the closed-loop question instead of the
 * open-loop one: whether the model still fits once the native renderer is
 * resident on the same device. Those are different verdicts and the caller
 * chooses which one it is asking for.
 */
export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const requested = url.searchParams.get("family");
  if (requested && !(MODEL_FAMILIES as readonly string[]).includes(requested)) {
    return NextResponse.json(
      { error: "unknown_family", detail: { family: requested, expected: MODEL_FAMILIES } },
      { status: 400 },
    );
  }
  const reserveRenderer = url.searchParams.get("reserveRenderer") === "1";
  const report = await preflight({
    families: requested ? [requested as ModelFamilyId] : undefined,
    reserveRenderer,
  });
  return NextResponse.json(report, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
