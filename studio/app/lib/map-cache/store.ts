// Content-addressed map asset store owned by the LOCAL SERVICE.
//
// Layout under the control directory (the default cache root):
//   location.json   user-selected data root, absent for the default
// and under the data root (default: the control directory itself):
//   index.json      snapshot: content records, URL aliases, closure receipts
//   index.log       journal of changes since the snapshot (one JSON line each)
//   objects/ab/<sha256>          verified, immutable content (STORED bytes:
//                                a Content-Encoding member keeps its encoded form)
//   incomplete/<sha256>.part     resumable transfer with a known digest
//   incomplete/u-<sha256>.part   transfer of an immutable URL without a digest;
//                                resumable only within the process that began it
//
// Integrity: every download streams to `incomplete/` while hashing; the file is
// renamed into `objects/` only after the digest (and declared size) verified.
// A warm hit stats the file and compares size+mtime with the record made at
// publication; a mismatch rehashes once and discards the file if the digest
// changed. Nothing is ever a hit until it was fully verified.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export const SHA256 = /^[a-f0-9]{64}$/;
/** Parts that survive a restart: their digest is the resume proof. */
const DURABLE_PART_FILE = /^[a-f0-9]{64}\.part$/;
/** Journal lines before the index snapshot is rewritten (amortizes the O(N) rewrite). */
const COMPACT_AFTER = 4096;
export const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/** Errors whose messages are shown to the user verbatim by the renderer. */
export class MapCacheError extends Error {
  constructor(message: string, name = "MapCacheError") {
    super(message);
    this.name = name;
  }
}

export function abortError(message: string) {
  return new MapCacheError(message, "AbortError");
}

export function notAuthorized(message: string) {
  return new MapCacheError(message, "NotAuthorized");
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "an unknown number of bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readJson(path: string, fallback: unknown): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A torn or corrupt control file is rebuilt from the durable state it describes.
    return fallback;
  }
}

/**
 * Write, fsync, then rename: after a crash the file is either the previous
 * or the new complete document, never a torn one.
 */
export async function writeJsonAtomic(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

export async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function unlinkQuietly(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") console.warn(`[map-cache] could not remove ${path}: ${errorMessage(error)}`);
  }
}

export async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Free bytes on the volume holding `directory`, or null when the platform
 * cannot tell (never a browser quota guess).
 */
export async function availableBytes(directory: string): Promise<number | null> {
  try {
    const fs = await statfs(directory);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
}

export async function assertWritable(directory: string) {
  const probe = join(directory, `.simforge-write-probe-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(probe, "");
  } catch (error) {
    throw new MapCacheError(`SimForge cannot write to ${directory}: ${errorMessage(error)}`);
  } finally {
    await unlinkQuietly(probe);
  }
}

export function normalizeEtag(header: string | undefined | null) {
  if (!header) return null;
  const value = header.trim().replace(/^W\//, "");
  return value === "" ? null : value;
}

/**
 * `etag` is the validator the delivery server sent when this content was
 * downloaded; a digest-less part is resumable only under it.
 * `contentEncoding` is the transfer form the STORED bytes are in; the
 * stream endpoint replays it so the browser decodes exactly once.
 */
export type ContentRecord = {
  bytes: number;
  mtimeMs: number;
  mediaType: string;
  etag: string | null;
  contentEncoding: string | null;
};

export type Receipt = { completedAt: number; assets: number; bytes: number };

type JournalEntry =
  | { c: string; b: number; m: number; t: string; e?: string; n?: string }
  | { u: string; s: string }
  | { d: string }
  | { r: string; v: Receipt };

type RawIndex = { version?: unknown; content?: unknown; urls?: unknown; receipts?: unknown };

function parseContentRecord(value: unknown): ContentRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<Record<keyof ContentRecord, unknown>>;
  if (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0 || typeof raw.mtimeMs !== "number") return null;
  return {
    bytes: raw.bytes as number,
    mtimeMs: raw.mtimeMs,
    mediaType: typeof raw.mediaType === "string" ? raw.mediaType : DEFAULT_MEDIA_TYPE,
    etag: typeof raw.etag === "string" ? raw.etag : null,
    contentEncoding: typeof raw.contentEncoding === "string" ? raw.contentEncoding : null,
  };
}

export function isReceipt(value: unknown): value is Receipt {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Partial<Record<keyof Receipt, unknown>>;
  return Number.isFinite(raw.completedAt)
    && Number.isSafeInteger(raw.assets) && (raw.assets as number) >= 0
    && Number.isSafeInteger(raw.bytes) && (raw.bytes as number) >= 0;
}

/** Entries of a persisted object whose values are still unknown. */
function entriesOf(value: unknown): Array<[string, unknown]> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : [];
}

export type VerifiedFile = { path: string; bytes: number; mediaType: string; etag: string | null; contentEncoding: string | null };

/**
 * One data root: verified objects plus the index describing them. Every
 * change is one appended journal line; the whole index is rewritten only at
 * open and every `COMPACT_AFTER` lines, so preparing a 30 GB corpus costs
 * O(members) index bytes instead of O(members²).
 */
export class CacheStore {
  readonly root: string;
  readonly objectsDir: string;
  readonly incompleteDir: string;
  readonly snapshotPath: string;
  readonly journalPath: string;
  readonly content = new Map<string, ContentRecord>();
  /** canonical URL → sha256 */
  readonly urls = new Map<string, string>();
  readonly receipts = new Map<string, Receipt>();
  usedBytes = 0;
  journalLines = 0;
  /** Serializes journal appends and snapshot rewrites. */
  private writing: Promise<void> = Promise.resolve();
  /**
   * Validator (ETag) of the delivery a digest-less part was interrupted
   * from; the only ground truth such a part can be resumed under.
   * part path → validator
   */
  readonly partValidators = new Map<string, string>();
  /** Set once a newer root replaced this one; capabilities keep reading, nothing is written. */
  readOnly = false;

  private constructor(root: string) {
    this.root = root;
    this.objectsDir = join(root, "objects");
    this.incompleteDir = join(root, "incomplete");
    this.snapshotPath = join(root, "index.json");
    this.journalPath = join(root, "index.log");
  }

  static async open(root: string) {
    const store = new CacheStore(root);
    await mkdir(store.objectsDir, { recursive: true });
    await mkdir(store.incompleteDir, { recursive: true });
    const index = (await readJson(store.snapshotPath, null)) as RawIndex | null;
    if (index !== null && typeof index === "object" && index.version === 1) {
      for (const [sha256, raw] of entriesOf(index.content)) {
        const record = SHA256.test(sha256) ? parseContentRecord(raw) : null;
        if (record) store.content.set(sha256, record);
      }
      for (const [href, sha256] of entriesOf(index.urls)) {
        if (typeof sha256 === "string" && SHA256.test(sha256)) store.urls.set(href, sha256);
      }
      for (const [key, receipt] of entriesOf(index.receipts)) {
        if (isReceipt(receipt)) store.receipts.set(key, receipt);
      }
    }
    let journal = "";
    try {
      journal = await readFile(store.journalPath, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    for (const line of journal.split("\n")) {
      if (line === "") continue;
      try {
        store.apply(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A torn final line (crash mid-append) carries nothing durable.
      }
      store.journalLines++;
    }
    await store.reconcile();
    // The store is only open once a consistent snapshot is on disk.
    await store.flush();
    return store;
  }

  /** Replay one journal entry (idempotent; snapshot + journal may overlap). */
  private apply(entry: Record<string, unknown>) {
    if (typeof entry.c === "string" && SHA256.test(entry.c)) {
      const record = parseContentRecord({ bytes: entry.b, mtimeMs: entry.m, mediaType: entry.t, etag: entry.e, contentEncoding: entry.n });
      if (record) this.content.set(entry.c, record);
    } else if (typeof entry.u === "string" && typeof entry.s === "string" && SHA256.test(entry.s)) {
      this.urls.set(entry.u, entry.s);
    } else if (typeof entry.d === "string") {
      this.content.delete(entry.d);
      for (const [href, sha256] of this.urls) {
        if (sha256 === entry.d) this.urls.delete(href);
      }
    } else if (typeof entry.r === "string" && isReceipt(entry.v)) {
      this.receipts.set(entry.r, { completedAt: entry.v.completedAt, assets: entry.v.assets, bytes: entry.v.bytes });
    }
  }

  /**
   * Make the index agree with the disk after a crash, a manual copy or a lost
   * index: objects without a record are adopted (their name is their digest,
   * verified on first use), records without an object are dropped, and stray
   * temporary files go. Only unknown objects are stat'ed, so a 30 GB corpus
   * costs one readdir per shard, not one stat per asset.
   */
  private async reconcile() {
    const present = new Set<string>();
    let changed = false;
    const shards = await readdir(this.objectsDir, { withFileTypes: true });
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const shardDir = join(this.objectsDir, shard.name);
      for (const entry of await readdir(shardDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!SHA256.test(entry.name) || entry.name.slice(0, 2) !== shard.name) {
          await unlinkQuietly(join(shardDir, entry.name));
          continue;
        }
        present.add(entry.name);
        if (this.content.has(entry.name)) continue;
        const info = await stat(join(shardDir, entry.name));
        // Unknown provenance: record a mtime that cannot match so the first hit rehashes.
        this.content.set(entry.name, { bytes: info.size, mtimeMs: -1, mediaType: DEFAULT_MEDIA_TYPE, etag: null, contentEncoding: null });
        changed = true;
      }
    }
    for (const sha256 of [...this.content.keys()]) {
      if (present.has(sha256)) continue;
      this.content.delete(sha256);
      changed = true;
    }
    for (const [href, sha256] of [...this.urls]) {
      if (this.content.has(sha256)) continue;
      this.urls.delete(href);
      changed = true;
    }
    for (const entry of await readdir(this.incompleteDir, { withFileTypes: true })) {
      if (!(entry.isFile() && DURABLE_PART_FILE.test(entry.name))) await rm(join(this.incompleteDir, entry.name), { recursive: true, force: true });
    }
    this.usedBytes = 0;
    for (const record of this.content.values()) this.usedBytes += record.bytes;
    if (changed || this.journalLines > 0) this.compact();
  }

  objectPath(sha256: string) {
    return join(this.objectsDir, sha256.slice(0, 2), sha256);
  }

  /** @param key `<sha256>` or `u-<sha256 of the canonical URL>` */
  partPath(key: string) {
    return join(this.incompleteDir, `${key}.part`);
  }

  async discardPart(part: string) {
    this.partValidators.delete(part);
    await unlinkQuietly(part);
  }

  /**
   * The verified file for `sha256`, or null. Trusts the publication record only
   * while size and mtime still match; otherwise rehashes once and either
   * refreshes the record or discards the changed file.
   */
  async verified(sha256: string): Promise<VerifiedFile | null> {
    const record = this.content.get(sha256);
    if (!record) return null;
    const path = this.objectPath(sha256);
    const info = await statOrNull(path);
    if (!info || !info.isFile()) {
      this.forget(sha256);
      return null;
    }
    if (info.size !== record.bytes || info.mtimeMs !== record.mtimeMs) {
      if ((await sha256File(path)) !== sha256) {
        await unlinkQuietly(path);
        this.forget(sha256);
        return null;
      }
      this.usedBytes += info.size - record.bytes;
      record.bytes = info.size;
      record.mtimeMs = info.mtimeMs;
      this.recordContent(sha256, record);
    }
    return { path, bytes: record.bytes, mediaType: record.mediaType, etag: record.etag, contentEncoding: record.contentEncoding };
  }

  /** Record a freshly published object. */
  async published(sha256: string, mediaType: string, etag: string | null, contentEncoding: string | null) {
    const info = await stat(this.objectPath(sha256));
    const previous = this.content.get(sha256);
    if (previous) this.usedBytes -= previous.bytes;
    const record: ContentRecord = { bytes: info.size, mtimeMs: info.mtimeMs, mediaType, etag, contentEncoding };
    this.content.set(sha256, record);
    this.usedBytes += info.size;
    this.recordContent(sha256, record);
  }

  private recordContent(sha256: string, record: ContentRecord) {
    const entry: JournalEntry = { c: sha256, b: record.bytes, m: record.mtimeMs, t: record.mediaType };
    if (record.etag) entry.e = record.etag;
    if (record.contentEncoding) entry.n = record.contentEncoding;
    this.journal(entry);
  }

  private forget(sha256: string) {
    const record = this.content.get(sha256);
    if (!record) return;
    this.usedBytes -= record.bytes;
    this.content.delete(sha256);
    for (const [href, target] of this.urls) {
      if (target === sha256) this.urls.delete(href);
    }
    this.journal({ d: sha256 });
  }

  alias(href: string, sha256: string) {
    if (this.urls.get(href) === sha256) return;
    this.urls.set(href, sha256);
    this.journal({ u: href, s: sha256 });
  }

  writeReceipt(key: string, receipt: Receipt) {
    this.receipts.set(key, receipt);
    this.journal({ r: key, v: receipt });
  }

  /** Remove every object, alias, receipt and partial transfer. */
  async clear() {
    await rm(this.objectsDir, { recursive: true, force: true });
    await rm(this.incompleteDir, { recursive: true, force: true });
    await mkdir(this.objectsDir, { recursive: true });
    await mkdir(this.incompleteDir, { recursive: true });
    this.content.clear();
    this.urls.clear();
    this.receipts.clear();
    this.partValidators.clear();
    this.usedBytes = 0;
    this.compact();
    await this.flush();
  }

  private journal(entry: JournalEntry) {
    if (this.readOnly) return;
    const line = `${JSON.stringify(entry)}\n`;
    this.journalLines++;
    this.writing = this.writing
      .then(() => appendFile(this.journalPath, line))
      .catch((error: unknown) => console.warn(`[map-cache] could not journal to ${this.journalPath}: ${errorMessage(error)}`));
    if (this.journalLines >= COMPACT_AFTER) this.compact();
  }

  /**
   * Rewrite the snapshot from memory and empty the journal. Ordered behind
   * pending appends; entries journaled meanwhile are replayed idempotently.
   */
  private compact() {
    if (this.readOnly) return;
    this.journalLines = 0;
    this.writing = this.writing
      .then(async () => {
        await writeJsonAtomic(this.snapshotPath, this.toJSON());
        await truncate(this.journalPath, 0).catch((error: unknown) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      })
      .catch((error: unknown) => console.warn(`[map-cache] could not persist ${this.snapshotPath}: ${errorMessage(error)}`));
  }

  flush() {
    return this.writing;
  }

  toJSON() {
    return {
      version: 1,
      content: Object.fromEntries(this.content),
      urls: Object.fromEntries(this.urls),
      receipts: Object.fromEntries(this.receipts),
    };
  }
}

/**
 * Parse a single-range `Range` header against `size`.
 * @returns null = serve the whole body
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const first = match[1] ?? "";
  const last = match[2] ?? "";
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}
