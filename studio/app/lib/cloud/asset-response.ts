import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getPresignedGetUrl } from "@/app/lib/s3/s3-presign";
import { browserAssetRedirectCacheControl, objectRedirect } from "@/app/lib/s3/local-object-redirect";
import { ensureMapAsset, resolveCachedMapAsset } from "@/app/lib/map-cache/service";
import { MapAccessError, parseLocalMapAssetUrl, resolveAuthorizedMapMember } from "./access";
import { primeCloudSession } from "./connection";
import { MAP_CACHE_BUCKET, type RegistryMember } from "./map-registry";

/**
 * Serve one immutable map member over the local first-party route. Members
 * that live in the local service's map cache stream from the verified object
 * (fetching it through the cache on a miss); members installed on this machine
 * redirect to the local object store exactly as before. Compressed members
 * are delivered as stored — `application/gzip`, no `Content-Encoding` — so
 * the client decompresses once, as it always has.
 */

const RANGE = /^bytes=(\d*)-(\d*)$/;
const IMMUTABLE = "private, max-age=31536000, immutable";

export function mapAccessErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof MapAccessError)) throw error;
  const status = error.name === "NotAuthorized"
    ? 403
    : error.name === "NotFound"
      ? 404
      : error.code === "invalid_map_asset_url" ? 400 : 502;
  return NextResponse.json({ error: error.code }, { status, headers: { "Cache-Control": "private, no-store" } });
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const match = RANGE.exec(header);
  if (!match) return "invalid";
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return "invalid";
  let start: number;
  let end: number;
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? size - 1 : Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return "invalid";
  }
  if (start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Stream a verified cache object with byte-range support. `sha256` is the
 * authorized member's identity; the path comes from the cache, never a caller.
 */
export async function streamCachedObject(
  request: Request,
  member: Pick<RegistryMember, "sha256" | "byteLength" | "mediaType">,
  ensureUrl: string,
  headOnly: boolean,
): Promise<Response> {
  let cached = await resolveCachedMapAsset(member.sha256);
  if (!cached) {
    await ensureMapAsset({
      requestId: `route:${member.sha256}:${Date.now()}`,
      url: ensureUrl,
      sha256: member.sha256,
      sizeBytes: member.byteLength,
    }, request.signal);
    cached = await resolveCachedMapAsset(member.sha256);
  }
  if (!cached || cached.sizeBytes !== member.byteLength) {
    return NextResponse.json({ error: "map_asset_unavailable" }, { status: 502, headers: { "Cache-Control": "private, no-store" } });
  }
  const headers = new Headers({
    "content-type": member.mediaType,
    "accept-ranges": "bytes",
    etag: `"${member.sha256}"`,
    "x-content-sha256": member.sha256,
    "cache-control": IMMUTABLE,
  });
  const range = parseRange(request.headers.get("range"), cached.sizeBytes);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${cached.sizeBytes}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? cached.sizeBytes - 1;
  headers.set("content-length", String(end - start + 1));
  if (range) headers.set("content-range", `bytes ${start}-${end}/${cached.sizeBytes}`);
  if (headOnly) return new Response(null, { status: range ? 206 : 200, headers });
  const stream = createReadStream(cached.path, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
}

/** Full handling of `/api/simforge/maps/<id>/<profile>-assets/<path>`. */
export async function serveLocalMapAsset(request: Request, headOnly: boolean): Promise<Response> {
  try {
    const url = new URL(request.url);
    const ref = parseLocalMapAssetUrl(`${url.pathname}${url.search}`);
    if (ref.kind !== "map") throw new MapAccessError("MapCacheError", "invalid_map_asset_url");
    await primeCloudSession();
    const { member } = await resolveAuthorizedMapMember(ref);
    if (member.bucket !== MAP_CACHE_BUCKET) {
      const response = objectRedirect(await getPresignedGetUrl(member.key, member.bucket, 60 * 60), 307);
      response.headers.set("Cache-Control", browserAssetRedirectCacheControl());
      return response;
    }
    return await streamCachedObject(request, member, url.pathname, headOnly);
  } catch (error) {
    return mapAccessErrorResponse(error);
  }
}
