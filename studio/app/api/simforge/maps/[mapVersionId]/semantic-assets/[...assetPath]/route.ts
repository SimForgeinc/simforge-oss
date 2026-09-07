import { serveLocalMapAsset } from "@/app/lib/cloud/asset-response";
import { requireScenarioContext } from "@/app/lib/scenario/http";

/**
 * One exact member of a map's native closure (`master.gltf` and its
 * resources), the same identity space the local compiler and Bevy renderer
 * materialize from. Same authorization as the browser members.
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
