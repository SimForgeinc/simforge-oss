/**
 * Direct browser-to-storage upload of an evaluation input.
 *
 * The bytes never pass through the web server: a video large enough to be worth
 * evaluating cannot survive a short-lived request handler, so the control plane
 * issues an exact-object storage grant and the browser writes to it. The server
 * then verifies the stored length and digest before the artifact becomes usable.
 *
 * `XMLHttpRequest` rather than `fetch` for the transfers: it is still the only
 * browser API that reports request-body progress, which a multi-gigabyte upload
 * needs.
 */

import type { EvaluationGateway } from "./gateway";
import { ComputeApiError } from "./gateway";
import type { UploadPurpose } from "./contracts";
import { hashFileSha256 } from "./sha256";

export type UploadPhase = "hashing" | "reserving" | "uploading" | "completing" | "done";

export type UploadProgress = {
  phase: UploadPhase;
  bytesDone: number;
  bytesTotal: number;
  /** Parts finished / total, for the multipart path. Null on a single PUT. */
  parts: { done: number; total: number } | null;
};

export type UploadedArtifact = {
  artifactId: string;
  sha256: string;
  bytes: number;
  /** True when the workspace already held these exact bytes and nothing was sent. */
  deduplicated: boolean;
};

export type UploadOptions = {
  purpose: UploadPurpose;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  metadata?: Record<string, string>;
};

/**
 * One PUT with progress, resolving to the stored object's ETag.
 *
 * Executor form rather than `Promise.withResolvers`: this package compiles
 * against the ES2022 lib, where that method does not exist.
 */
function putBlob(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  let resolve!: (value: string | null) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string | null>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  const request = new XMLHttpRequest();
  request.open("PUT", url, true);
  for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);

  const abort = () => request.abort();
  signal?.addEventListener("abort", abort, { once: true });

  request.upload.onprogress = (event) => onBytes(event.loaded);
  request.onload = () => {
    signal?.removeEventListener("abort", abort);
    if (request.status >= 200 && request.status < 300) {
      resolve(request.getResponseHeader("etag"));
      return;
    }
    reject(
      new ComputeApiError(
        request.status,
        "storage_rejected",
        `Storage rejected the upload with ${request.status}. The grant may have expired; retry to get a fresh one.`,
        request.responseText,
      ),
    );
  };
  request.onerror = () => {
    signal?.removeEventListener("abort", abort);
    reject(new ComputeApiError(0, "storage_unreachable", "The upload could not reach storage.", null));
  };
  request.onabort = () => {
    signal?.removeEventListener("abort", abort);
    reject(new DOMException("Upload cancelled", "AbortError"));
  };
  request.send(body);
  return promise;
}

/**
 * Hash, reserve, transfer and complete one input object.
 *
 * Completion is the server's verification step, not a client claim: a mismatch
 * comes back as `upload_mismatch` and this throws rather than pretending the
 * artifact exists.
 */
export async function uploadEvaluationInput(
  gateway: EvaluationGateway,
  file: File,
  options: UploadOptions,
): Promise<UploadedArtifact> {
  const total = file.size;
  const report = (phase: UploadPhase, bytesDone: number, parts: UploadProgress["parts"] = null) =>
    options.onProgress?.({ phase, bytesDone, bytesTotal: total, parts });

  report("hashing", 0);
  const sha256 = await hashFileSha256(file, (hashed) => report("hashing", hashed));

  report("reserving", 0);
  const reservation = await gateway.reserveUpload(
    {
      purpose: options.purpose,
      mediaType: file.type || "application/octet-stream",
      sha256,
      sizeBytes: total,
      filename: file.name,
      metadata: options.metadata,
    },
    options.signal,
  );

  if (!reservation.uploadRequired) {
    report("done", total);
    return { artifactId: reservation.artifactId, sha256, bytes: total, deduplicated: true };
  }

  const grant = reservation.grant;
  if (!grant) {
    throw new ComputeApiError(
      500,
      "grant_missing",
      "The upload reservation requires a transfer but carried no storage grant.",
      reservation,
    );
  }

  let parts: { partNumber: number; etag: string }[] | undefined;
  if (grant.mode === "put") {
    report("uploading", 0);
    await putBlob(grant.url, file, grant.headers, (bytes) => report("uploading", bytes), options.signal);
  } else {
    const size = grant.partSizeBytes;
    const partTotal = grant.parts.length;
    const collected: { partNumber: number; etag: string }[] = [];
    let uploaded = 0;
    for (const part of grant.parts) {
      const start = (part.partNumber - 1) * size;
      if (start >= total) break;
      const slice = file.slice(start, Math.min(start + size, total));
      const base = uploaded;
      const done = collected.length;
      const etag = await putBlob(
        part.url,
        slice,
        {},
        (bytes) => report("uploading", base + bytes, { done, total: partTotal }),
        options.signal,
      );
      if (!etag) {
        throw new ComputeApiError(
          502,
          "part_etag_missing",
          `Storage did not return an ETag for part ${part.partNumber}, so the upload cannot be completed.`,
          null,
        );
      }
      collected.push({ partNumber: part.partNumber, etag: etag.replace(/"/g, "") });
      uploaded += slice.size;
      report("uploading", uploaded, { done: collected.length, total: partTotal });
    }
    parts = collected;
  }

  report("completing", total, parts ? { done: parts.length, total: parts.length } : null);
  const completion = await gateway.completeUpload(
    reservation.uploadId,
    parts ? { parts } : {},
    options.signal,
  );

  report("done", completion.bytes);
  return {
    artifactId: completion.artifactId,
    sha256: completion.sha256,
    bytes: completion.bytes,
    deduplicated: false,
  };
}
