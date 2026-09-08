import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { MAP_CACHE_BUCKET } from "@/app/lib/cloud/map-registry";
import { readLocalObjectMetadata, streamLocalObject, writeLocalObjectStream } from "@/app/lib/s3/s3-object";
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
  const queryChecksum = url.searchParams.get("sha256")?.toLowerCase();
  const headerChecksumBase64 = request.headers.get("x-amz-checksum-sha256");
  const headerChecksum = headerChecksumBase64
    ? Buffer.from(headerChecksumBase64, "base64").toString("hex")
    : null;
  const declaredChecksum = queryChecksum ?? headerChecksum;
  const declaredLengthHeader = request.headers.get("content-length");
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);

  const uploadId = url.searchParams.get("uploadId");
  if (uploadId) {
    // A part is sized by the uploader's chunking, so buffering one is bounded.
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (declaredLength !== null && declaredLength !== bytes.byteLength) {
      return Response.json({ error: "object_size_mismatch" }, { status: 400 });
    }
    const partSha256 = createHash("sha256").update(bytes).digest("hex");
    if (declaredChecksum && declaredChecksum !== partSha256) {
      return Response.json({ error: "object_checksum_mismatch" }, { status: 400 });
    }
    await writeMultipartPart(uploadId, Number(url.searchParams.get("partNumber")), bytes);
    return new Response(null, { status: 200, headers: { etag: `"${partSha256}"` } });
  }

  const contentType = url.searchParams.get("content-type")
    ?? request.headers.get("content-type")
    ?? "application/octet-stream";
  if (!request.body) return Response.json({ error: "object_size_mismatch" }, { status: 400 });
  // Whole objects are renders: a 20 s clip is tens of megabytes and a longer
  // or higher-resolution one is larger still, so the body is streamed to disk
  // and hashed on the way through rather than held in memory. The digest gate
  // is unchanged - it is applied to what actually landed, before the file is
  // promoted to its key.
  const written = await writeLocalObjectStream(
    bucket,
    key.join("/"),
    Readable.fromWeb(request.body as import("node:stream/web").ReadableStream<Uint8Array>),
    contentType,
    { sha256: declaredChecksum ?? null, length: declaredLength },
  );
  if ("refusal" in written) return Response.json({ error: written.refusal }, { status: 400 });
  return Response.json({ checksumSha256: written.checksumSha256Hex, sizeBytes: written.sizeBytes });
}
