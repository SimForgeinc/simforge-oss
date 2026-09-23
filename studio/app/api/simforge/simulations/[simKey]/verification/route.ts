import { NextResponse } from "next/server";
import { VerifyScenarioSimulationSchema } from "@/app/lib/scenario/contracts";
import { readJson, requireScenarioContext } from "@/app/lib/scenario/http";
import { recordSimulationVerification } from "@/app/lib/scenario/sim-result-store";

type Context = { params: Promise<{ simKey: string }> };

/**
 * The editor reports its local preview's trace digest against the
 * authoritative result. Equal is "Verified"; a mismatch is a determinism bug
 * and is kept as telemetry.
 */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = VerifyScenarioSimulationSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_simulation_verification" }, { status: 400 });
  const { simKey } = await route.params;
  if (!/^[a-f0-9]{64}$/.test(simKey)) return NextResponse.json({ error: "invalid_sim_key" }, { status: 400 });
  const recorded = await recordSimulationVerification({
    workspaceId: auth.context.workspaceId,
    userId: auth.context.userId,
    simKey,
    documentId: parsed.data.documentId ?? null,
    localTraceSha256: parsed.data.localTraceSha256,
    localRuntime: parsed.data.localRuntime,
  });
  return recorded
    ? NextResponse.json(recorded)
    : NextResponse.json({ error: "simulation_not_found" }, { status: 404 });
}
