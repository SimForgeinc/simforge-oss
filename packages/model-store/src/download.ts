import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { LockHasher, expectedDigest, verifyFile } from "./integrity";
import type { ModelLockFile } from "./lock";

/**
 * Resumable, digest-verified downloads from the Hugging Face resolve endpoint.
 *
 * Resume is a `Range` request from the length of the partial `<file>.part`,
 * which matters at this scale: a 4.9 GB shard interrupted at 90% must not
 * restart. Because a resumed transfer cannot hash the bytes it did not
 * receive, the digest is verified in a second streaming pass over the
 * completed file rather than incrementally — so a resumed download is checked
 * exactly as strictly as a fresh one, and a corrupted prefix is caught
 * instead of being trusted because "the tail arrived cleanly".
 *
 * A fresh (non-resumed) download hashes while writing and skips the second
 * pass, so the common case reads the bytes once.
 */
export const HF_ENDPOINT = process.env.HF_ENDPOINT?.trim() || "https://huggingface.co";
const USER_AGENT = "simforge-model-store/1.0";

export type DownloadProgress = {
  readonly path: string;
  readonly bytesDone: number;
  readonly bytesTotal: number | null;
  readonly resumedFrom: number;
};

export type DownloadOptions = {
  readonly repo: string;
  readonly revision: string;
  readonly file: ModelLockFile;
  readonly destination: string;
  /** Bearer token; only ever passed for a gated repo or after a 401/403. */
  readonly token?: string | null;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly signal?: AbortSignal;
};

export type DownloadResult = {
  readonly path: string;
  readonly bytes: number;
  readonly resumedFrom: number;
  readonly skipped: boolean;
  readonly verifiedBy: "stream" | "second-pass" | "already-present";
};

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unauthorized"
      | "gated"
      | "not_found"
      | "range_unsupported"
      | "digest_mismatch"
      | "size_mismatch"
      | "network"
      | "aborted",
    readonly retryable: boolean,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export function resolveUrl(repo: string, revision: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${HF_ENDPOINT}/${repo}/resolve/${revision}/${encoded}`;
}

async function partSize(partPath: string): Promise<number> {
  try {
    return (await stat(partPath)).size;
  } catch {
    return 0;
  }
}

/**
 * Fetch one file, resuming an interrupted `.part` when present.
 *
 * A file already at its pinned digest is left alone (skip-if-present, the
 * same skip-if-present discipline the desktop encoder build uses for its digest-pinned artifacts), so a
 * re-run of an install is cheap and a warm assets root works offline.
 */
export async function downloadLockedFile(options: DownloadOptions): Promise<DownloadResult> {
  const { repo, revision, file, destination, token, onProgress, signal } = options;
  const expected = expectedDigest(file);
  if (!expected) {
    throw new DownloadError(`${file.path}: lock record has no digest to verify against`, "digest_mismatch", false);
  }

  const existing = await verifyFile(destination, file);
  if (existing.present && existing.sizeOk && existing.digestOk) {
    return {
      path: destination,
      bytes: existing.sizeBytes ?? 0,
      resumedFrom: 0,
      skipped: true,
      verifiedBy: "already-present",
    };
  }
  if (existing.present && !existing.digestOk) {
    // A present-but-wrong file is not a resume candidate: appending to it
    // would produce a larger wrong file.
    await unlink(destination).catch(() => {});
  }

  await mkdir(dirname(destination), { recursive: true });
  const partPath = `${destination}.part`;
  let resumeFrom = await partSize(partPath);
  if (file.sizeBytes !== null && resumeFrom > file.sizeBytes) {
    // Longer than the pinned size: the partial is not a prefix of this file.
    await unlink(partPath).catch(() => {});
    resumeFrom = 0;
  }

  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

  const url = resolveUrl(repo, revision, file.path);
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "follow", signal });
  } catch (error) {
    if (signal?.aborted) throw new DownloadError(`${file.path}: aborted`, "aborted", true);
    throw new DownloadError(`${file.path}: ${(error as Error).message}`, "network", true);
  }

  if (response.status === 401 || response.status === 403) {
    throw new DownloadError(
      `${repo}/${file.path}: ${response.status} — this repository requires an ` +
        "accepted licence and a Hugging Face access token",
      token ? "gated" : "unauthorized",
      false,
      { repo, revision, status: response.status },
    );
  }
  if (response.status === 404) {
    throw new DownloadError(`${repo}/${file.path}: not found at ${revision}`, "not_found", false, {
      repo,
      revision,
    });
  }
  if (resumeFrom > 0 && response.status === 200) {
    // The server ignored the Range header and is sending the whole file.
    // Restart cleanly rather than concatenating a duplicate prefix.
    resumeFrom = 0;
    await unlink(partPath).catch(() => {});
  } else if (resumeFrom > 0 && response.status !== 206) {
    throw new DownloadError(
      `${repo}/${file.path}: resume requested but server replied ${response.status}`,
      "range_unsupported",
      true,
      { status: response.status },
    );
  }
  if (!response.ok && response.status !== 206) {
    throw new DownloadError(
      `${repo}/${file.path}: ${response.status} ${response.statusText}`,
      "network",
      response.status >= 500,
    );
  }
  if (!response.body) {
    throw new DownloadError(`${repo}/${file.path}: empty response body`, "network", true);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "");
  const bytesTotal = file.sizeBytes ?? (Number.isFinite(contentLength) ? resumeFrom + contentLength : null);

  // Fresh download: hash while writing. Resumed: hash in a second pass, since
  // the missing prefix cannot be fed to an incremental hasher.
  const hasher = resumeFrom === 0 ? new LockHasher(file) : null;
  let bytesDone = resumeFrom;
  let sinceReport = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hasher?.update(chunk as Buffer);
      bytesDone += (chunk as Buffer).byteLength;
      sinceReport += (chunk as Buffer).byteLength;
      // Report at ~8 MiB granularity: per-chunk callbacks would dominate the
      // cost of writing a multi-gigabyte shard.
      if (onProgress && sinceReport >= 8 << 20) {
        sinceReport = 0;
        onProgress({ path: file.path, bytesDone, bytesTotal, resumedFrom: resumeFrom });
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      meter,
      createWriteStream(partPath, { flags: resumeFrom > 0 ? "a" : "w" }),
      { signal },
    );
  } catch (error) {
    if (signal?.aborted) {
      // The `.part` file stays on disk: that is what makes the install
      // resumable across an app restart.
      throw new DownloadError(`${file.path}: aborted`, "aborted", true, { bytesDone });
    }
    throw new DownloadError(`${file.path}: ${(error as Error).message}`, "network", true, { bytesDone });
  }

  onProgress?.({ path: file.path, bytesDone, bytesTotal, resumedFrom: resumeFrom });

  const written = (await stat(partPath)).size;
  if (file.sizeBytes !== null && written !== file.sizeBytes) {
    throw new DownloadError(
      `${file.path}: wrote ${written} bytes, lock pins ${file.sizeBytes}`,
      "size_mismatch",
      true,
      { written, expected: file.sizeBytes },
    );
  }

  let verifiedBy: DownloadResult["verifiedBy"];
  if (hasher) {
    const { digest } = hasher.finish();
    if (digest !== expected) {
      await unlink(partPath).catch(() => {});
      throw new DownloadError(
        `${file.path}: ${file.digestSource} digest ${digest} != pinned ${expected}`,
        "digest_mismatch",
        true,
        { actual: digest, expected },
      );
    }
    verifiedBy = "stream";
  } else {
    await rename(partPath, destination);
    const verdict = await verifyFile(destination, file);
    if (!verdict.digestOk) {
      // A resumed file that fails verification had a bad prefix; drop the
      // whole thing so the retry is a clean download, not another resume.
      await unlink(destination).catch(() => {});
      throw new DownloadError(
        `${file.path}: resumed download failed verification (${verdict.reason ?? "digest mismatch"})`,
        "digest_mismatch",
        true,
        { actual: verdict.actual, expected },
      );
    }
    return { path: destination, bytes: written, resumedFrom: resumeFrom, skipped: false, verifiedBy: "second-pass" };
  }

  await rename(partPath, destination);
  return { path: destination, bytes: written, resumedFrom: resumeFrom, skipped: false, verifiedBy };
}

/** Hugging Face account name for a token. The token itself is never returned. */
export async function tokenIdentity(token: string): Promise<{ name: string } | null> {
  const response = await fetch(`${HF_ENDPOINT}/api/whoami-v2`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { name?: string };
  return payload.name ? { name: payload.name } : null;
}
