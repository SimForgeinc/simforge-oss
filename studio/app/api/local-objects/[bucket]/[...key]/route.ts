import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { LOCAL_ARTIFACT_BUCKET } from "@/app/lib/db/config";
import { readLocalObjectMetadata, writeLocalObjectStream } from "@/app/lib/s3/s3-object";
import { writeMultipartPart } from "@/app/lib/s3/s3-presign";
import { verifyLocalObjectRequest } from "@/app/lib/s3/local-object-auth";
import { localObjectGetResponse, refusesMapCache } from "@/app/lib/s3/local-object-response";
type RouteContext = { params: Promise<{ bucket: string; key: string[] }> };


export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { bucket, key } = await context.params;
  return localObjectGetResponse(request, bucket, key);
}

export async function HEAD(request: Request, context: RouteContext): Promise<Response> {
  if (!(await verifyLocalObjectRequest(request))) return new Response(null, { status: 403 });
  const { bucket, key } = await context.params;
  const refused = refusesMapCache(bucket);
  if (refused) return refused;
  try {
    const objectKey = key.join("/");
    const metadata = await readLocalObjectMetadata(bucket, objectKey);
    const immutableMapAsset = bucket === LOCAL_ARTIFACT_BUCKET && objectKey.startsWith("maps/");
    return new Response(null, {
      headers: {
        "content-type": metadata.contentType,
        "content-length": String(metadata.sizeBytes),
        etag: `"${metadata.checksumSha256Hex}"`,
        "x-content-sha256": metadata.checksumSha256Hex,
        "cache-control": immutableMapAsset ? "private, max-age=31536000, immutable" : "no-store",
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
