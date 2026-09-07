import { mapCacheErrorResponse, mapCacheJson } from "@/app/lib/map-cache/http";
import { getMapCacheService } from "@/app/lib/map-cache/service";

/** Explicit user action: delete every cached map object of the active root. Job/project artifacts are untouched. */
export async function POST() {
  try {
    const service = await getMapCacheService();
    await service.clear();
    return mapCacheJson(await service.status());
  } catch (error) {
    return mapCacheErrorResponse("clear", error);
  }
}
