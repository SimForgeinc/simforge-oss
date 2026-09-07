import { NextResponse } from "next/server";
import { beginCloudConnect, CloudConnectionError } from "@/app/lib/cloud/connection";
import { readJson, requireScenarioMutationOrigin, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

/** Start the external-browser sign-in; the renderer opens `authorizationUrl` in the system browser. */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const body = await readJson(request) as { origin?: unknown } | null;
  if (body !== null && (typeof body !== "object" || (body.origin !== undefined && typeof body.origin !== "string"))) {
    return NextResponse.json({ error: "invalid_connect_request" }, { status: 400 });
  }
  try {
    const result = await beginCloudConnect({ origin: body?.origin as string | undefined });
    return NextResponse.json(result, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    if (error instanceof CloudConnectionError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 400 });
    }
    throw error;
  }
}
