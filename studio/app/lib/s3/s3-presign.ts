import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { LOCAL_ARTIFACTS_DIR } from "@/app/lib/db/config";
import { readLocalObjectMetadata, writeLocalObject } from "@/app/lib/s3/s3-object";
import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import { signLocalObjectUrl } from "./local-object-auth";
import { getRegisteredMap, MAP_CACHE_BUCKET } from "../cloud/map-registry";

export const MEDIA_URL_TTL_SECONDS = 3600;
export const PRESIGN_TTL_SECONDS = MEDIA_URL_TTL_SECONDS;
export const UPLOAD_TTL_SECONDS = 900;

/** A content-addressed object never changes, so its bytes are cacheable forever. */
export const IMMUTABLE_OBJECT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type CompletedPart = { ETag?: string; PartNumber?: number };

export function checksumBoundPutRequiredHeaders(
  contentType: string,
  checksumSha256Hex: string,
): Readonly<Record<string, string>> {
  return {
    "content-type": contentType,
    "x-amz-checksum-sha256": Buffer.from(checksumSha256Hex, "hex").toString("base64"),
    "x-amz-sdk-checksum-algorithm": "SHA256",
  };
}

/**
 * The object endpoint for one key, as a path plus query to be signed.
 *
 * `LOCAL_OBJECT_ORIGIN` is a placeholder that never leaves this module:
 * `signLocalObjectUrl` returns only the pathname and query, so no origin the
 * server could guess is ever handed to a client. That is deliberate — see the
 * comment there. Reintroducing a configured base here would resurrect the bug
 * where every presigned URL pointed a remote browser at its own loopback.
 */
const LOCAL_OBJECT_ORIGIN = "http://local-objects.invalid";

function objectUrl(bucket: string, key: string): URL {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`/api/local-objects/${encodeURIComponent(bucket)}/${encoded}`, LOCAL_OBJECT_ORIGIN);
}

export async function getPresignedGetUrl(
  key: string,
  bucket = S3_BUCKET,
  expiresIn = MEDIA_URL_TTL_SECONDS,
  responseContentDisposition?: string,
  /** `response-cache-control`: what the store says about the bytes it returns. */
  responseCacheControl?: string,
  _preferGzip = false,
): Promise<string> {
  const url = objectUrl(bucket, key);
  if (responseContentDisposition) url.searchParams.set("response-content-disposition", responseContentDisposition);
  if (responseCacheControl) url.searchParams.set("response-cache-control", responseCacheControl);
  return signLocalObjectUrl(url, "GET", expiresIn);
}

/** Cached map artifacts keep their map-scoped authorization on every worker read. */
export async function getMapArtifactDownloadUrl(
  mapVersionId: string,
  key: string,
  bucket: string,
  sha256: string,
  byteLength: number,
  preferGzip = false,
): Promise<string> {
  // A closure member is named by its digest: the bytes behind this key cannot
  // change, so the store is told to say so and the browser keeps them instead
  // of re-fetching thousands of tiles on every load.
  if (bucket !== MAP_CACHE_BUCKET) {
    return getPresignedGetUrl(key, bucket, MEDIA_URL_TTL_SECONDS, undefined, IMMUTABLE_OBJECT_CACHE_CONTROL, preferGzip);
  }
  const map = await getRegisteredMap(mapVersionId);
  if (map) {
    // A member may be published for either profile; both are served by the
    // route that authorizes that profile's members for this map version.
    for (const [profile, members] of [["browser", map.browser], ["semantic", map.semantic]] as const) {
      for (const [relativePath, member] of members) {
        if (member.bucket === bucket && member.key === key
          && member.sha256 === sha256 && member.byteLength === byteLength) {
          const route = profile === "browser" ? "browser-assets" : "semantic-assets";
          return `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/${route}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
        }
      }
    }
  }
  throw new Error("map_artifact_member_missing");
}

export async function getPresignedPutUrl(
  key: string,
  contentType: string,
  bucket = S3_BUCKET,
  expiresIn = UPLOAD_TTL_SECONDS,
  checksumSha256Hex?: string | null,
): Promise<string> {
  const url = objectUrl(bucket, key);
  url.searchParams.set("content-type", contentType);
  if (checksumSha256Hex) url.searchParams.set("sha256", checksumSha256Hex.toLowerCase());
  return signLocalObjectUrl(url, "PUT", expiresIn);
}

export async function headS3Object(key: string, bucket = S3_BUCKET) {
  const metadata = await readLocalObjectMetadata(bucket, key);
  return {
    contentLength: metadata.sizeBytes,
    contentType: metadata.contentType,
    etag: `"${metadata.checksumSha256Hex}"`,
    checksumSha256: Buffer.from(metadata.checksumSha256Hex, "hex").toString("base64"),
  };
}

export async function getS3ObjectChecksum(key: string, bucket = S3_BUCKET) {
  const metadata = await readLocalObjectMetadata(bucket, key);
  return {
    checksumSha256: Buffer.from(metadata.checksumSha256Hex, "hex").toString("base64"),
    objectSize: metadata.sizeBytes,
  };
}

function multipartRoot(uploadId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(uploadId)) throw new Error("invalid_upload_id");
  return resolve(LOCAL_ARTIFACTS_DIR, ".multipart", uploadId);
}

export async function initiateS3MultipartUpload(
  key: string,
  contentType: string,
  bucket = S3_BUCKET,
) {
  const uploadId = randomUUID();
  const root = multipartRoot(uploadId);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "manifest.json"), JSON.stringify({ key, contentType, bucket }));
  return { uploadId, bucket, key };
}

export async function getPresignedMultipartPartUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  bucket = S3_BUCKET,
  expiresIn = UPLOAD_TTL_SECONDS,
) {
  const url = objectUrl(bucket, key);
  url.searchParams.set("uploadId", uploadId);
  url.searchParams.set("partNumber", String(partNumber));
  return signLocalObjectUrl(url, "PUT", expiresIn);
}

export async function completeS3MultipartUpload(
  key: string,
  uploadId: string,
  parts: CompletedPart[],
  bucket = S3_BUCKET,
): Promise<void> {
  const root = multipartRoot(uploadId);
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as {
    key: string; contentType: string; bucket: string;
  };
  if (manifest.key !== key || manifest.bucket !== bucket) throw new Error("multipart_coordinate_mismatch");
  const ordered = [...parts].sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));
  const buffers = await Promise.all(ordered.map((part) => readFile(resolve(root, `${part.PartNumber}.part`))));
  await writeLocalObject(bucket, key, Buffer.concat(buffers), manifest.contentType);
  await rm(root, { recursive: true, force: true });
}

export async function abortS3MultipartUpload(
  _key: string,
  uploadId: string,
  _bucket = S3_BUCKET,
): Promise<void> {
  await rm(multipartRoot(uploadId), { recursive: true, force: true });
}

export async function writeMultipartPart(uploadId: string, partNumber: number, bytes: Uint8Array): Promise<void> {
  if (!Number.isInteger(partNumber) || partNumber < 1) throw new Error("invalid_part_number");
  const path = resolve(multipartRoot(uploadId), `${partNumber}.part`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
