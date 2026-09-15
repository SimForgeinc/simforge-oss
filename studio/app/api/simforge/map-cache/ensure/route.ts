import { HostOrigin } from "@simforge-oss/studio-host/node";
import { mapCacheErrorResponse, mapCacheJson, readMapCacheBody } from "@/app/lib/map-cache/http";
import { getMapCacheService } from "@/app/lib/map-cache/service";

/**
 * `{ requestId, url, sha256?, sizeBytes? }` -> DesktopMapCacheEnsureResult.
 * Long-lived: answers when the asset is verified on disk. The caller drops the
 * connection (or POSTs /cancel with the same requestId) to stop waiting; the
 * transfer itself continues while any other subscriber still wants it.
 */
export async function POST(request: Request) {
  try {
    const body = await readMapCacheBody(request);
    // The authority this request arrived on is what decides whether an
     // absolute asset URL is this host's: a remote GUI's URLs carry the
     // origin it loaded from, which is the host's network address.
    return mapCacheJson(await (await getMapCacheService()).ensure(body, request.signal, HostOrigin.fromReceivedRequest(request)));
  } catch (error) {
    return mapCacheErrorResponse("ensure", error);
  }
}
