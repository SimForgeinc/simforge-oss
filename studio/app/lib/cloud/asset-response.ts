import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { ensureMapAsset, MapCacheError, resolveCachedMapAsset } from "@/app/lib/map-cache/service";
import { MapAccessError, parseLocalMapAssetUrl, resolveAuthorizedMapMember } from "./access";
import { primeCloudSession } from "./connection";
import type { RegistryMember } from "./map-registry";

/**
 * One authorized URL for installed and downloaded members alike. Admission
 * into the shared store verifies the digest; delivery never mints a second,
 * expiring URL. Revalidation rechecks map access but reuses the client's bytes.
 * Compressed members are delivered as stored, without Content-Encoding, so
 * the client decompresses once.
 */

const RANGE = /^bytes=(\d*)-(\d*)$/;
const REVALIDATE = "private, no-cache";

export function mapAccessErrorResponse(error: unknown): NextResponse {
  if (error instanceof MapCacheError) {
    if (error.name === "IntegrityError") error = new MapAccessError("MapCacheError", "map_member_integrity");
    else if (error.name === "NotFoundError") error = new MapAccessError("NotFound", "map_member_missing");
  }
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
      requestId: `route:${randomUUID()}`,
      url: ensureUrl,
      sha256: member.sha256,
      sizeBytes: member.byteLength,
    }, request.signal);
    cached = await resolveCachedMapAsset(member.sha256);
  }
  if (!cached) throw new MapAccessError("NotFound", "map_member_missing");
  if (cached.sizeBytes !== member.byteLength) throw new MapAccessError("MapCacheError", "map_member_integrity");
  const headers = new Headers({
    "content-type": member.mediaType,
    "accept-ranges": "bytes",
    etag: `"${member.sha256}"`,
    "x-content-sha256": member.sha256,
    "cache-control": REVALIDATE,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  });
  const etag = headers.get("etag")!;
  const matches = request.headers.get("if-none-match")?.split(",").some((candidate) => {
    const value = candidate.trim().replace(/^W\//, "");
    return value === "*" || value === etag;
  });
  if (matches) return new Response(null, { status: 304, headers });
  const ifRange = request.headers.get("if-range");
  const range = parseRange(ifRange && ifRange !== etag ? null : request.headers.get("range"), cached.sizeBytes);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${cached.sizeBytes}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? cached.sizeBytes - 1;
  headers.set("content-length", String(end - start + 1));
  if (range) headers.set("content-range", `bytes ${start}-${end}/${cached.sizeBytes}`);
  if (headOnly || cached.sizeBytes === 0) return new Response(null, { status: range ? 206 : 200, headers });
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
    return await streamCachedObject(request, member, url.pathname, headOnly);
  } catch (error) {
    return mapAccessErrorResponse(error);
  }
}
