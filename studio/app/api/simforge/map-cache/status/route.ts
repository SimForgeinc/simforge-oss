import { mapCacheErrorResponse, mapCacheJson } from "@/app/lib/map-cache/http";
import { getMapCacheService } from "@/app/lib/map-cache/service";

/** Location, usage, free space and the chosen-volume-unavailable reason of the map cache. */
export async function GET() {
  try {
    return mapCacheJson(await (await getMapCacheService()).status());
  } catch (error) {
    return mapCacheErrorResponse("status", error);
  }
}
