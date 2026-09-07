import { getMapCacheService } from "@/app/lib/map-cache/service";

type Context = { params: Promise<{ capability: string; name: string }> };

/**
 * Verified cached bytes behind a capability issued by /ensure: GET/HEAD, byte
 * ranges, ETag, the stored Content-Encoding, never Chromium-cached. The current
 * session is re-authorized for the underlying map URL on every request.
 */
export async function GET(request: Request, context: Context) {
  const { capability } = await context.params;
  return (await getMapCacheService()).serveCapability(request, capability);
}

export async function HEAD(request: Request, context: Context) {
  const { capability } = await context.params;
  return (await getMapCacheService()).serveCapability(request, capability);
}
