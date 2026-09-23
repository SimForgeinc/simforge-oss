import { Readable } from "node:stream";

import { MAP_CACHE_BUCKET } from "@/app/lib/cloud/map-registry";
import { LOCAL_ARTIFACT_BUCKET } from "@/app/lib/db/config";
import { readLocalObjectMetadata, streamLocalObject } from "@/app/lib/s3/s3-object";
import { verifyLocalObjectRequest } from "@/app/lib/s3/local-object-auth";

/** Map cache content is delivered only through the access-gated map routes; a digest is not a capability. */
export function refusesMapCache(bucket: string): Response | null {
  return bucket === MAP_CACHE_BUCKET ? Response.json({ error: "object_not_found" }, { status: 404 }) : null;
}

/**
 * `GET /api/local-objects/<bucket>/<key>`: one signed local object. Shared by the route and by
 * in-process readers that follow a map member's same-origin redirect (the simulation closure),
 * which have no network origin to fetch it from.
 */
export async function localObjectGetResponse(request: Request, bucket: string, key: readonly string[]): Promise<Response> {
  if (!(await verifyLocalObjectRequest(request))) return Response.json({ error: "object_access_denied" }, { status: 403 });
  const refused = refusesMapCache(bucket);
  if (refused) return refused;
  const objectKey = key.join("/");
  try {
    const metadata = await readLocalObjectMetadata(bucket, objectKey);
    // What the signer asked the store to say about these bytes, then the
    // route's own answer. A presigned URL for a content-addressed member
    // carries the immutable header, which is the whole reason a browser
    // stops re-fetching thousands of closure members on every load.
    const requested = new URL(request.url).searchParams.get("response-cache-control");
    const immutableMapAsset = bucket === LOCAL_ARTIFACT_BUCKET && objectKey.startsWith("maps/");
    const cacheControl = requested ?? (immutableMapAsset ? "private, max-age=31536000, immutable" : "no-store");
    const headers = new Headers({
      "content-type": metadata.contentType,
      "content-length": String(metadata.sizeBytes),
      etag: `"${metadata.checksumSha256Hex}"`,
      "x-content-sha256": metadata.checksumSha256Hex,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
    if (metadata.contentEncoding) headers.set("content-encoding", metadata.contentEncoding);
    const disposition = new URL(request.url).searchParams.get("response-content-disposition");
    if (disposition) headers.set("content-disposition", disposition);
    return new Response(Readable.toWeb(streamLocalObject(bucket, objectKey)) as ReadableStream, { headers });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Response.json({ error: "object_not_found" }, { status: 404 });
    throw error;
  }
}

