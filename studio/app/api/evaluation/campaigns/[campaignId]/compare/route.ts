import { NextResponse } from "next/server";
import { comparePolicies } from "@/app/lib/evaluation/ledger";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ campaignId: string }> };

/**
 * Comparison of N policy columns: `?policy=<id>&policy=<id>[&policy=...]`.
 *
 * Repeated `policy` rather than `a`/`b`: comparing three models is the normal
 * case and the two-sided form made it three pages. Order is significant — the
 * first column is the baseline every verdict is taken against — so the
 * parameter order is preserved rather than sorted. Duplicates are kept: the
 * same policy in two columns is a legitimate repeat control.
 */
export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { campaignId } = await route.params;
  const policies = new URL(request.url).searchParams.getAll("policy").filter((id) => id.length > 0);
  if (policies.length < 2) {
    return NextResponse.json(
      {
        error: "compare_requires_two_or_more_policies",
        detail: { received: policies.length, parameter: "policy" },
      },
      { status: 400 },
    );
  }
  const comparison = await comparePolicies(auth.context, campaignId, policies);
  if (!comparison) return NextResponse.json({ error: "policy_not_found" }, { status: 404 });
  return NextResponse.json(comparison, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
