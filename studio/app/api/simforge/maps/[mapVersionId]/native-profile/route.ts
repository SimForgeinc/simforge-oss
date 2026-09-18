import { NextResponse } from "next/server";
import { getRegisteredMap } from "@/app/lib/cloud/map-registry";
import { LOCAL_SESSION } from "@/app/lib/auth/session";
import { getAppContext } from "@/app/lib/db/app-context";
import { listScenarioMapDescriptors } from "@/app/lib/scenario/document-store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ mapVersionId: string }> };
const SHA256 = /^[a-f0-9]{64}$/;

/** Immutable native profile identity; filesystem paths never cross this boundary. */
export async function GET(_request: Request, context: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { mapVersionId } = await context.params;
  const descriptor = (await listScenarioMapDescriptors(getAppContext(LOCAL_SESSION))).find((entry) => entry.mapVersionId === mapVersionId);
  const registered = await getRegisteredMap(mapVersionId);
  if (!registered || !descriptor || registered.semantic.size === 0 || !registered.registryReleaseDigest || !registered.canonicalDigest || !SHA256.test(registered.registryReleaseDigest) || !SHA256.test(registered.canonicalDigest)) {
    return NextResponse.json({ error: "native_map_unavailable" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  }
  return NextResponse.json({
    mapVersionId,
    sourceMapId: descriptor.sourceMapId,
    profile: "native",
    releaseDigest: registered.registryReleaseDigest,
    canonicalDigest: registered.canonicalDigest,
    availability: "local",
    members: [...registered.semantic.entries()].map(([relativePath, member]) => ({ relativePath, sha256: member.sha256, sizeBytes: member.byteLength })).sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  }, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
