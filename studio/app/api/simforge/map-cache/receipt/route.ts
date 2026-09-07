import { mapCacheErrorResponse, mapCacheJson, readMapCacheBody } from "@/app/lib/map-cache/http";
import { getMapCacheService } from "@/app/lib/map-cache/service";

/** `?key=` -> `{ receipt: DesktopMapCacheReceipt | null }` for the active cache root. */
export async function GET(request: Request) {
  try {
    const key = new URL(request.url).searchParams.get("key");
    return mapCacheJson({ receipt: await (await getMapCacheService()).receipt(key) });
  } catch (error) {
    return mapCacheErrorResponse("receipt", error);
  }
}

/** `{ key, receipt: { completedAt, assets, bytes } }`: record a completed closure. */
export async function PUT(request: Request) {
  try {
    const body = await readMapCacheBody(request);
    await (await getMapCacheService()).writeReceipt(body.key, body.receipt);
    return mapCacheJson({ ok: true });
  } catch (error) {
    return mapCacheErrorResponse("writeReceipt", error);
  }
}
