import { HostOrigin } from "@simforge-oss/studio-host/node";
import { mapCacheErrorResponse, mapCacheJson, readMapCacheBody } from "@/app/lib/map-cache/http";
import { getMapCacheService } from "@/app/lib/map-cache/service";

/**
 * `{ url, sha256? }` -> `{ cached }`: verified on disk and readable by the
 * current session; no network. An absolute asset URL is this host's own only
 * if it matches the authority this request arrived on, which is the only
 * thing that knows where the host actually is.
 */
export async function POST(request: Request) {
  try {
    const body = await readMapCacheBody(request);
    return mapCacheJson({ cached: await (await getMapCacheService()).has(body, HostOrigin.fromReceivedRequest(request)) });
  } catch (error) {
    return mapCacheErrorResponse("has", error);
  }
}
