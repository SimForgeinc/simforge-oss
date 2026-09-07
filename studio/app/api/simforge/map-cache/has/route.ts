import { mapCacheErrorResponse, mapCacheJson, readMapCacheBody } from "@/app/lib/map-cache/http";
import { getMapCacheService } from "@/app/lib/map-cache/service";

/** `{ url, sha256? }` -> `{ cached }`: verified on disk and readable by the current session; no network. */
export async function POST(request: Request) {
  try {
    const body = await readMapCacheBody(request);
    return mapCacheJson({ cached: await (await getMapCacheService()).has(body) });
  } catch (error) {
    return mapCacheErrorResponse("has", error);
  }
}
