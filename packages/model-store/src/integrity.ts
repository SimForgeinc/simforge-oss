import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ModelLockFile } from "./lock";

/**
 * Integrity verification against the two upstream-published digest kinds.
 *
 * `hf-lfs` records carry a sha256 of the content. `git-blob-sha1` records
 * carry the git blob id, which is `sha1("blob " + byteLength + "\0" + content)`
 * — a digest that binds the length as well as the bytes, and that a reviewer
 * can reproduce with `git hash-object` against the upstream repository.
 *
 * Both are streamed. A 4.9 GB shard is never buffered, and the same code
 * serves the download hot path (hash while writing) and a later re-verify.
 */
export type FileVerdict = {
  readonly path: string;
  readonly present: boolean;
  readonly sizeBytes: number | null;
  readonly sizeOk: boolean;
  readonly digestOk: boolean;
  readonly digestSource: ModelLockFile["digestSource"];
  readonly expected: string;
  readonly actual: string | null;
  readonly reason?: string;
};

export function expectedDigest(file: ModelLockFile): string {
  return (file.digestSource === "hf-lfs" ? file.sha256 : file.blobId) ?? "";
}

/**
 * Streaming hasher for one lock record.
 *
 * The git-blob variant needs the byte length in its prefix before any content
 * is hashed, which is why the expected size is a constructor argument rather
 * than discovered while reading: a file whose length differs from the lock
 * cannot produce the pinned blob id, and reporting that as a size mismatch is
 * clearer than reporting it as a digest mismatch.
 */
export class LockHasher {
  private readonly hash;
  private bytes = 0;

  constructor(private readonly file: ModelLockFile) {
    if (file.digestSource === "hf-lfs") {
      this.hash = createHash("sha256");
    } else {
      this.hash = createHash("sha1");
      this.hash.update(`blob ${file.sizeBytes ?? 0}\0`);
    }
  }

  update(chunk: Buffer | Uint8Array): void {
    this.hash.update(chunk);
    this.bytes += chunk.byteLength;
  }

  /** `{ digest, bytes }`; compare `digest` with {@link expectedDigest}. */
  finish(): { digest: string; bytes: number } {
    return { digest: this.hash.digest("hex"), bytes: this.bytes };
  }
}

export async function verifyFile(path: string, file: ModelLockFile): Promise<FileVerdict> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return {
      path: file.path,
      present: false,
      sizeBytes: null,
      sizeOk: false,
      digestOk: false,
      digestSource: file.digestSource,
      expected: expectedDigest(file),
      actual: null,
      reason: "missing",
    };
  }

  const sizeOk = file.sizeBytes === null || size === file.sizeBytes;
  if (!sizeOk) {
    // A wrong length cannot hash to the pinned digest, so skip the read and
    // report the cheaper, more informative failure.
    return {
      path: file.path,
      present: true,
      sizeBytes: size,
      sizeOk: false,
      digestOk: false,
      digestSource: file.digestSource,
      expected: expectedDigest(file),
      actual: null,
      reason: `size ${size} != ${file.sizeBytes}`,
    };
  }

  const hasher = new LockHasher(file);
  await new Promise<void>((resolveRead, rejectRead) => {
    const stream = createReadStream(path, { highWaterMark: 8 << 20 });
    stream.on("data", (chunk) => hasher.update(chunk as Buffer));
    stream.on("error", rejectRead);
    stream.on("end", () => resolveRead());
  });
  const { digest } = hasher.finish();
  const expected = expectedDigest(file);
  return {
    path: file.path,
    present: true,
    sizeBytes: size,
    sizeOk: true,
    digestOk: digest === expected,
    digestSource: file.digestSource,
    expected,
    actual: digest,
    ...(digest === expected ? {} : { reason: "digest mismatch" }),
  };
}

/**
 * Checkpoint identity: sha256 over the ordered `"<shard> <sha256>"` lines of
 * the weight shards, matching `gen-models-lock.mjs` and
 * `simforge_alpamayo.families.checkpoint_digest`. Computed from the lock, so
 * naming the checkpoint that produced a result never re-hashes 22-72 GB.
 *
 * Bare 64-hex, no `sha256:` prefix: this is the value
 * `simforge.model_versions.checkpoint_digest` stores and the value the engine
 * reports on `hello` / `GET /healthz`, so the worker's identity check is a
 * string equality with nothing to normalise.
 */
export function checkpointDigestFromLock(files: readonly ModelLockFile[]): string {
  const shards = [...files]
    .filter((file) => file.path.endsWith(".safetensors"))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  if (!shards.length) throw new Error("no safetensors shards to digest");
  const hasher = createHash("sha256");
  for (const shard of shards) hasher.update(`${shard.path} ${shard.sha256}\n`);
  return hasher.digest("hex");
}
