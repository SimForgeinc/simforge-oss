import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { MAP_CACHE_BUCKET } from "@/app/lib/cloud/map-registry";
import { readLocalObjectMetadata, streamLocalObject, writeLocalObject } from "@/app/lib/s3/s3-object";
import { writeMultipartPart } from "@/app/lib/s3/s3-presign";
import { verifyLocalObjectRequest } from "@/app/lib/s3/local-object-auth";

type RouteContext = { params: Promise<{ bucket: string; key: string[] }> };

/** Map cache content is delivered only through the access-gated map routes; a digest is not a capability. */
function refusesMapCache(bucket: string): Response | null {
  return bucket === MAP_CACHE_BUCKET ? Response.json({ error: "object_not_found" }, { status: 404 }) : null;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  if (!(await verifyLocalObjectRequest(request))) return Response.json({ error: "object_access_denied" }, { status: 403 });
  const { bucket, key } = await context.params;
  const refused = refusesMapCache(bucket);
  if (refused) return refused;
  const objectKey = key.join("/");
  try {
    const metadata = await readLocalObjectMetadata(bucket, objectKey);
    const headers = new Headers({
      "content-type": metadata.contentType,
      "content-length": String(metadata.sizeBytes),
      etag: `"${metadata.checksumSha256Hex}"`,
      "x-content-sha256": metadata.checksumSha256Hex,
      "cache-control": "no-store",
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

export async function HEAD(request: Request, context: RouteContext): Promise<Response> {
  if (!(await verifyLocalObjectRequest(request))) return new Response(null, { status: 403 });
  const { bucket, key } = await context.params;
  const refused = refusesMapCache(bucket);
  if (refused) return refused;
  try {
    const metadata = await readLocalObjectMetadata(bucket, key.join("/"));
    return new Response(null, {
      headers: {
        "content-type": metadata.contentType,
        "content-length": String(metadata.sizeBytes),
        etag: `"${metadata.checksumSha256Hex}"`,
        "x-content-sha256": metadata.checksumSha256Hex,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Response(null, { status: 404 });
    throw error;
  }
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  if (!(await verifyLocalObjectRequest(request))) return Response.json({ error: "object_access_denied" }, { status: 403 });
  const { bucket, key } = await context.params;
  const refused = refusesMapCache(bucket);
  if (refused) return refused;
  const url = new URL(request.url);
  const bytes = new Uint8Array(await request.arrayBuffer());
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== bytes.byteLength) {
    return Response.json({ error: "object_size_mismatch" }, { status: 400 });
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  const queryChecksum = url.searchParams.get("sha256")?.toLowerCase();
  const headerChecksumBase64 = request.headers.get("x-amz-checksum-sha256");
  const headerChecksum = headerChecksumBase64
    ? Buffer.from(headerChecksumBase64, "base64").toString("hex")
    : null;
  const declaredChecksum = queryChecksum ?? headerChecksum;
  if (declaredChecksum && declaredChecksum !== actualSha256) {
    return Response.json({ error: "object_checksum_mismatch" }, { status: 400 });
  }
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (uploadId) {
    await writeMultipartPart(uploadId, partNumber, bytes);
    return new Response(null, { status: 200, headers: { etag: `"${actualSha256}"` } });
  }
  const contentType = url.searchParams.get("content-type")
    ?? request.headers.get("content-type")
    ?? "application/octet-stream";
  const metadata = await writeLocalObject(bucket, key.join("/"), bytes, contentType);
  return Response.json({ checksumSha256: metadata.checksumSha256Hex, sizeBytes: metadata.sizeBytes });
}
