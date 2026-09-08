import { NextRequest, NextResponse } from "next/server";
import { UpdateAiProviderSettingsSchema } from "@/app/lib/ai-providers/contracts";
import { getAiProviderSettingsStatus, updateAiProviderSettings } from "@/app/lib/ai-providers/settings";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { readJson, requireScenarioMutationOrigin } from "@/app/lib/scenario/http";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** Status only: which providers are configured and where keys live. Keys themselves never leave the service. */
export async function GET(request: NextRequest) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;
  return auth.apply(NextResponse.json(await getAiProviderSettingsStatus(), { headers: NO_STORE }));
}

/** Store/clear provider keys in the OS vault. */
export async function PATCH(request: NextRequest) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsed = UpdateAiProviderSettingsSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_ai_provider_settings", details: parsed.error.flatten() },
        { status: 400 },
      ),
    );
  }
  return auth.apply(NextResponse.json(await updateAiProviderSettings(parsed.data), { headers: NO_STORE }));
}
