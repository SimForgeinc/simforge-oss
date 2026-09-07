import { serveLocalMapAsset } from "@/app/lib/cloud/asset-response";
import { requireScenarioContext } from "@/app/lib/scenario/http";

/**
 * One exact member of a published immutable browser asset set, resolved from
 * verified registry metadata and gated on the map's access (anonymous: the
 * real RFS and owner-installed maps; account maps need the active session).
 */
export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return serveLocalMapAsset(request, false);
}

export async function HEAD(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return serveLocalMapAsset(request, true);
}
