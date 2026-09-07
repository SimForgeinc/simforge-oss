import { mapCacheErrorResponse, mapCacheJson, readMapCacheBody } from "@/app/lib/map-cache/http";
import { getMapCacheService } from "@/app/lib/map-cache/service";

/** `{ requestId }`: withdraw one ensure() subscriber; the last one aborts the transfer. */
export async function POST(request: Request) {
  try {
    const body = await readMapCacheBody(request);
    (await getMapCacheService()).cancel(body.requestId);
    return mapCacheJson({ ok: true });
  } catch (error) {
    return mapCacheErrorResponse("cancel", error);
  }
}
