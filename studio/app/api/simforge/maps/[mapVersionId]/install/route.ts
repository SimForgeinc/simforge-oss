import { NextResponse } from "next/server";
import { MapAccessError } from "@/app/lib/cloud/access";
import { assertLocalMapAccess, getMapInstallState, startMapInstall } from "@/app/lib/cloud/maps";
import type { MapProfile } from "@/app/lib/cloud/map-registry";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ mapVersionId: string }> };

function parseProfile(value: unknown): MapProfile | null {
  return value === "browser" || value === "semantic" ? value : null;
}

function accessErrorResponse(error: unknown) {
  if (!(error instanceof MapAccessError)) throw error;
  const status = error.name === "NotAuthorized" ? 403 : error.name === "NotFound" ? 404 : 502;
  return NextResponse.json({ error: error.code }, { status, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}

/** Current install state of one map profile; idempotent and free of side effects. */
export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { mapVersionId } = await route.params;
  const profile = parseProfile(new URL(request.url).searchParams.get("profile") ?? "browser");
  if (!profile) return NextResponse.json({ error: "invalid_map_profile" }, { status: 400 });
  return NextResponse.json(getMapInstallState(mapVersionId, profile), { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}

/**
 * Start or join the install of one map profile: complete verified closure in
 * the local cache, registered identity, materialized directory. Returns the
 * state immediately; progress is real member/byte accounting of the transfer.
 */
export async function POST(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { mapVersionId } = await route.params;
  const body = await readJson(request) as { profile?: unknown } | null;
  const profile = parseProfile(body?.profile ?? "browser");
  if (!profile) return NextResponse.json({ error: "invalid_map_profile" }, { status: 400 });
  try {
    // Refuse up front with the exact reason instead of recording an error job.
    await assertLocalMapAccess(mapVersionId);
  } catch (error) {
    return accessErrorResponse(error);
  }
  return NextResponse.json(startMapInstall(mapVersionId, profile), {
    status: 202,
    headers: SCENARIO_PRIVATE_CACHE_HEADERS,
  });
}
