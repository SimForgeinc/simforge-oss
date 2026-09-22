import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  blobVerifyMode,
  contentAddressedBlobPath,
  markBlobVerified,
  verifyCachedBlob,
  type BlobVerifyMode,
} from '@simforge-oss/render';

/**
 * The worker's persistent content-addressed blob cache.
 *
 * - One layout, `<root>/blobs/sha256/<aa>/<sha256>`, shared by every job,
 *   worker restarts, image updates and co-located workers (dev, staging and
 *   prod containers on one box may mount the same root: a blob is its digest).
 * - A blob is hashed once while it streams in, then stamped read-only
 *   (`@simforge-oss/render` `markBlobVerified`); later reads prove it with one
 *   `stat` (`SIMFORGE_CACHE_VERIFY=full` re-hashes on every read).
 * - One transfer per digest per process: a job asking for a blob the
 *   background prewarm is already fetching joins that transfer (and promotes
 *   it to job priority) instead of starting a second one.
 * - Transfers resume: a partial file survives aborts, retries, job attempts
 *   and restarts, and continues with an HTTP range request.
 * - Job transfers pre-empt prewarm: while a job is downloading, prewarm starts
 *   nothing and its in-flight transfers are parked (partials kept); while a
 *   job renders, prewarm runs with few lanes and a byte-rate cap; idle, it
 *   runs at full speed.
 * - Connection failures shrink the job lane count (AIMD) and are retried with
 *   backoff for as long as the store keeps making progress; a job only fails
 *   when no byte has arrived for `stallTimeoutMs`.
 */

export type BlobPriority = 'job' | 'prewarm';
export type BlobStoreMode = 'idle' | 'job-downloading' | 'job-running';

export interface BlobSource {
  /** A URL for the blob; `refresh` asks for a new one (after a 403 or expiry). */
  url(refresh: boolean): Promise<{ url: string; headers: Readonly<Record<string, string>> }>;
}

export interface BlobRequest {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly source: BlobSource;
  readonly priority: BlobPriority;
  /** Bytes appended to disk for this blob (including resumed bytes when first seen). */
  readonly onBytes?: (bytes: number) => void;
  /** Destination override inside another content-addressed root (the actor closure's blob cache). */
  readonly path?: string;
}

export interface BlobStoreOptions {
  readonly root: string;
  /** Lane budget for job transfers; adaptive between `minJobConcurrency` and this. */
  readonly jobConcurrency?: number;
  readonly minJobConcurrency?: number;
  readonly prewarmIdleConcurrency?: number;
  readonly prewarmBusyConcurrency?: number;
  /** Byte-rate cap for prewarm while a job renders (0 = uncapped). */
  readonly prewarmBusyBytesPerSecond?: number;
  readonly stallTimeoutMs?: number;
  /** Abort a single request that delivers no byte for this long. */
  readonly requestIdleTimeoutMs?: number;
  /** Distinguishes this process's partial files from a co-located worker's. */
  readonly instanceTag?: string;
  readonly verify?: BlobVerifyMode;
  readonly fetch?: typeof fetch;
  readonly log?: (event: Record<string, unknown>) => void;
}

export class BlobUnavailableError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'BlobUnavailableError';
  }
}

class ParkedError extends Error {
  constructor() {
    super('prewarm transfer parked for a job download');
    this.name = 'ParkedError';
  }
}

interface Transfer {
  readonly sha256: string;
  priority: BlobPriority;
  readonly promise: Promise<string>;
  controller: AbortController;
  readonly listeners: Set<(bytes: number) => void>;
}

function isNetworkError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { name?: string; code?: string; message?: string; cause?: unknown };
    if (candidate.name === 'TimeoutError' || candidate.name === 'IdleTimeoutError') return true;
    if (typeof candidate.code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|UND_ERR_)/.test(candidate.code)) return true;
    if (typeof candidate.message === 'string' && /fetch failed|socket|terminated|other side closed|network/i.test(candidate.message)) return true;
    current = candidate.cause;
  }
  return false;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Counting semaphore whose limit can change at runtime. */
class Lanes {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private limitValue: number) {}
  get limit(): number { return this.limitValue; }
  get inUse(): number { return this.active; }
  setLimit(limit: number): void {
    this.limitValue = limit;
    this.drain();
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.active >= this.limitValue) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(wake);
      });
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }
  private drain(): void {
    while (this.active < this.limitValue && this.waiters.length > 0) {
      this.active += 1;
      this.waiters.shift()!();
    }
  }
}

/** Token bucket shared by prewarm transfers while a job renders. */
class RateLimiter {
  private tokens = 0;
  private last = Date.now();
  constructor(private bytesPerSecond: number) {}
  set rate(bytesPerSecond: number) { this.bytesPerSecond = bytesPerSecond; }
  async take(bytes: number, signal: AbortSignal): Promise<void> {
    if (this.bytesPerSecond <= 0) return;
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.bytesPerSecond, this.tokens + ((now - this.last) / 1000) * this.bytesPerSecond);
      this.last = now;
      if (this.tokens >= bytes || this.tokens >= this.bytesPerSecond) {
        this.tokens -= bytes;
        return;
      }
      await delay(Math.max(10, ((bytes - this.tokens) / this.bytesPerSecond) * 1000), signal);
    }
  }
}

export interface BlobStoreStats {
  readonly mode: BlobStoreMode;
  readonly jobLanes: number;
  readonly prewarmLanes: number;
  readonly inflight: number;
  readonly downloadedBytes: number;
  readonly networkErrors: number;
}

export class BlobStore {
  readonly root: string;
  private readonly opts: Required<Omit<BlobStoreOptions, 'log' | 'fetch' | 'instanceTag' | 'verify'>>;
  private readonly verify: BlobVerifyMode;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (event: Record<string, unknown>) => void;
  readonly instanceTag: string;
  private readonly inflight = new Map<string, Transfer>();
  private readonly jobLanes: Lanes;
  private readonly prewarmLanes: Lanes;
  private readonly prewarmRate: RateLimiter;
  private modeValue: BlobStoreMode = 'idle';
  private successesSinceShrink = 0;
  private lastProgressAt = Date.now();
  private downloadedBytes = 0;
  private networkErrors = 0;

  constructor(options: BlobStoreOptions) {
    this.root = options.root;
    this.opts = {
      root: options.root,
      jobConcurrency: options.jobConcurrency ?? 16,
      minJobConcurrency: options.minJobConcurrency ?? 2,
      prewarmIdleConcurrency: options.prewarmIdleConcurrency ?? 16,
      prewarmBusyConcurrency: options.prewarmBusyConcurrency ?? 2,
      prewarmBusyBytesPerSecond: options.prewarmBusyBytesPerSecond ?? 4 * 1024 * 1024,
      stallTimeoutMs: options.stallTimeoutMs ?? 300_000,
      requestIdleTimeoutMs: options.requestIdleTimeoutMs ?? 60_000,
    };
    this.verify = options.verify ?? blobVerifyMode();
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? ((event) => console.error(JSON.stringify(event)));
    this.instanceTag = (options.instanceTag ?? 'worker').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
    this.jobLanes = new Lanes(this.opts.jobConcurrency);
    this.prewarmLanes = new Lanes(this.opts.prewarmIdleConcurrency);
    this.prewarmRate = new RateLimiter(0);
  }

  get mode(): BlobStoreMode { return this.modeValue; }

  stats(): BlobStoreStats {
    return {
      mode: this.modeValue,
      jobLanes: this.jobLanes.limit,
      prewarmLanes: this.prewarmLanes.limit,
      inflight: this.inflight.size,
      downloadedBytes: this.downloadedBytes,
      networkErrors: this.networkErrors,
    };
  }

  /** Job phases steer prewarm: parked while a job downloads, throttled while it renders, full speed idle. */
  setMode(mode: BlobStoreMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    if (mode === 'job-downloading') {
      this.prewarmLanes.setLimit(0);
      this.prewarmRate.rate = 0;
      for (const transfer of this.inflight.values()) {
        if (transfer.priority === 'prewarm') transfer.controller.abort(new ParkedError());
      }
    } else if (mode === 'job-running') {
      this.prewarmLanes.setLimit(this.opts.prewarmBusyConcurrency);
      this.prewarmRate.rate = this.opts.prewarmBusyBytesPerSecond;
    } else {
      this.prewarmLanes.setLimit(this.opts.prewarmIdleConcurrency);
      this.prewarmRate.rate = 0;
      this.jobLanes.setLimit(this.opts.jobConcurrency);
    }
  }

  path(sha256: string): string {
    return contentAddressedBlobPath(this.root, sha256);
  }

  /** True when the blob is cached and verified (stamp, or a full hash in `full` mode / for unstamped files). */
  async has(sha256: string, sizeBytes: number): Promise<boolean> {
    return verifyCachedBlob(this.path(sha256), sha256, sizeBytes, this.verify);
  }

  /** Cheap presence check for prewarm planning: exists with the right size (no hash). */
  async present(sha256: string, sizeBytes: number): Promise<boolean> {
    try {
      const info = await stat(this.path(sha256));
      return info.isFile() && info.size === sizeBytes;
    } catch {
      return false;
    }
  }

  /** Resolves to the verified blob path, fetching it if needed. */
  async ensure(request: BlobRequest, signal: AbortSignal): Promise<string> {
    const existing = this.inflight.get(request.sha256);
    if (existing) {
      if (request.priority === 'job' && existing.priority === 'prewarm') {
        // Promote: park the prewarm transfer (its partial bytes stay on disk)
        // and restart it on a job lane, unthrottled, resuming where it stopped.
        existing.priority = 'job';
        existing.controller.abort(new ParkedError());
      }
      if (request.onBytes) existing.listeners.add(request.onBytes);
      return this.awaitTransfer(existing, request, signal);
    }
    const file = request.path ?? this.path(request.sha256);
    if (await verifyCachedBlob(file, request.sha256, request.sizeBytes, this.verify)) return file;
    // Re-check after the await: another caller may have started the transfer.
    const raced = this.inflight.get(request.sha256);
    if (raced) return this.ensure(request, signal);
    const controller = new AbortController();
    const listeners = new Set<(bytes: number) => void>();
    if (request.onBytes) listeners.add(request.onBytes);
    const transfer: Transfer = {
      sha256: request.sha256,
      priority: request.priority,
      controller,
      listeners,
      promise: undefined as unknown as Promise<string>,
    };
    (transfer as { promise: Promise<string> }).promise = this.run(transfer, request)
      .finally(() => {
        if (this.inflight.get(request.sha256) === transfer) this.inflight.delete(request.sha256);
      });
    this.inflight.set(request.sha256, transfer);
    return this.awaitTransfer(transfer, request, signal);
  }

  private async awaitTransfer(transfer: Transfer, request: BlobRequest, signal: AbortSignal): Promise<string> {
    const cancelled = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    cancelled.catch(() => undefined);
    try {
      return await Promise.race([transfer.promise, cancelled]);
    } catch (error) {
      // A parked prewarm transfer that a job joined meanwhile is restarted at job priority.
      if (error instanceof ParkedError && request.priority === 'job' && !signal.aborted) return this.ensure(request, signal);
      throw error;
    } finally {
      if (request.onBytes) transfer.listeners.delete(request.onBytes);
    }
  }

  private partialPath(sha256: string): string {
    return path.join(this.root, 'partial', `${sha256}.${this.instanceTag}`);
  }

  private async run(transfer: Transfer, request: BlobRequest): Promise<string> {
    let refresh = false;
    let backoffMs = 500;
    let integrityFailures = 0;
    let refusals = 0;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const lanes = transfer.priority === 'job' ? this.jobLanes : this.prewarmLanes;
      const release = await lanes.acquire(transfer.controller.signal);
      const laneKind = transfer.priority;
      try {
        const result = await this.fetchOnce(transfer, request, refresh);
        if (laneKind === 'job') this.onSuccess();
        return result;
      } catch (error) {
        if (error instanceof ParkedError || transfer.controller.signal.aborted) {
          throw transfer.controller.signal.reason instanceof Error ? transfer.controller.signal.reason : error;
        }
        if (error instanceof BlobUnavailableError && error.message.includes('integrity')) {
          integrityFailures += 1;
          await rm(this.partialPath(request.sha256), { force: true });
          if (integrityFailures >= 2) throw error;
          continue;
        }
        if (error instanceof BlobUnavailableError && error.message.includes(' 403')) {
          // Expired or revoked signature: ask the source for a new URL.
          refusals += 1;
          if (refusals >= 3) throw new BlobUnavailableError(`blob ${request.sha256} refused (403) after ${refusals} fresh URLs`, false);
          refresh = true;
        } else if (error instanceof BlobUnavailableError && !error.retryable) {
          throw error;
        } else if (isNetworkError(error) || (error instanceof BlobUnavailableError && error.retryable)) {
          this.networkErrors += 1;
          if (laneKind === 'job') this.onNetworkError();
        } else {
          throw error;
        }
        if (Date.now() - this.lastProgressAt > this.opts.stallTimeoutMs || attempts >= 25) {
          throw new BlobUnavailableError(
            `blob ${request.sha256} stalled: no byte received for ${Math.round((Date.now() - this.lastProgressAt) / 1000)} s (last error: ${error instanceof Error ? error.message : String(error)})`,
            true,
          );
        }
        this.log({ event: 'blob.retry', sha256: request.sha256, priority: transfer.priority, backoffMs, error: error instanceof Error ? error.message : String(error) });
      } finally {
        release();
      }
      await delay(backoffMs + Math.floor(Math.random() * 250), transfer.controller.signal);
      backoffMs = Math.min(30_000, backoffMs * 2);
    }
  }

  private onNetworkError(): void {
    const next = Math.max(this.opts.minJobConcurrency, Math.floor(this.jobLanes.limit / 2));
    if (next < this.jobLanes.limit) {
      this.log({ event: 'blob.lanes', from: this.jobLanes.limit, to: next, reason: 'network_error' });
      this.jobLanes.setLimit(next);
    }
    this.successesSinceShrink = 0;
  }

  private onSuccess(): void {
    this.successesSinceShrink += 1;
    if (this.jobLanes.limit < this.opts.jobConcurrency && this.successesSinceShrink >= this.jobLanes.limit) {
      this.successesSinceShrink = 0;
      this.jobLanes.setLimit(this.jobLanes.limit + 1);
    }
  }

  private async fetchOnce(transfer: Transfer, request: BlobRequest, refresh: boolean): Promise<string> {
    const final = request.path ?? this.path(request.sha256);
    const partial = this.partialPath(request.sha256);
    await mkdir(path.dirname(partial), { recursive: true });
    await mkdir(path.dirname(final), { recursive: true });

    // Resume: re-hash the bytes already on disk, then ask only for the rest.
    const digest = createHash('sha256');
    let offset = 0;
    try {
      const info = await stat(partial);
      if (info.size > request.sizeBytes) {
        await rm(partial, { force: true });
      } else if (info.size > 0) {
        for await (const chunk of createReadStream(partial)) digest.update(chunk as Buffer);
        offset = info.size;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (offset > 0) for (const listener of transfer.listeners) listener(offset);

    if (offset < request.sizeBytes || request.sizeBytes === 0) {
      const { url, headers } = await request.source.url(refresh);
      const idle = new AbortController();
      let idleTimer: NodeJS.Timeout | undefined;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(Object.assign(new Error('blob transfer idle timeout'), { name: 'IdleTimeoutError' })), this.opts.requestIdleTimeoutMs);
      };
      armIdle();
      const signal = AbortSignal.any([transfer.controller.signal, idle.signal]);
      try {
        const response = await this.fetchImpl(url, {
          headers: { ...headers, ...(offset > 0 ? { range: `bytes=${offset}-` } : {}) },
          redirect: 'error',
          signal,
        });
        if (response.status === 403) throw new BlobUnavailableError(`blob ${request.sha256} download returned 403`, true);
        if (response.status === 404 || response.status === 410) throw new BlobUnavailableError(`blob ${request.sha256} download returned ${response.status}`, false);
        if (response.status >= 500 || response.status === 429) throw new BlobUnavailableError(`blob ${request.sha256} download returned ${response.status}`, true);
        if (!response.ok || !response.body) throw new BlobUnavailableError(`blob ${request.sha256} download returned ${response.status}`, false);
        if (offset > 0 && response.status !== 206) {
          // The origin ignored the range: start over.
          await rm(partial, { force: true });
          await response.body.cancel().catch(() => undefined);
          return this.fetchOnce(transfer, request, false);
        }
        const handle = await open(partial, offset > 0 ? 'a' : 'w', 0o600);
        const out = handle.createWriteStream();
        try {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            if (transfer.priority === 'prewarm') await this.prewarmRate.take(value.byteLength, signal);
            digest.update(value);
            if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve));
            offset += value.byteLength;
            this.downloadedBytes += value.byteLength;
            this.lastProgressAt = Date.now();
            for (const listener of transfer.listeners) listener(value.byteLength);
            if (offset > request.sizeBytes) throw new BlobUnavailableError(`blob ${request.sha256} integrity mismatch: more than ${request.sizeBytes} bytes`, false);
          }
        } finally {
          // Flush what arrived so a retry resumes after it; closes the handle.
          await new Promise<void>((resolve) => out.end(() => resolve()));
        }
      } finally {
        clearTimeout(idleTimer);
      }
    }

    const actual = digest.digest('hex');
    if (offset !== request.sizeBytes || actual !== request.sha256) {
      throw new BlobUnavailableError(`blob ${request.sha256} integrity mismatch: got ${actual}/${offset}, expected ${request.sizeBytes} bytes`, false);
    }
    await markBlobVerified(partial, request.sha256);
    try {
      await rename(partial, final);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await unlink(partial).catch(() => undefined);
    }
    return final;
  }

  /** Moves pre-layout flat cache files (`<root>/<sha256>`) into the blob layout. */
  async migrateLegacyLayout(): Promise<number> {
    let moved = 0;
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    for (const name of entries) {
      if (/^[0-9a-f]{64}\.[0-9a-f-]{36}\.part$/.test(name)) {
        await rm(path.join(this.root, name), { force: true });
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const target = this.path(name);
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await rename(path.join(this.root, name), target);
        moved += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return moved;
  }
}

export interface CachedBlobEntry {
  readonly file: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly lastUsedMs: number;
  readonly links: number;
}

/** Every blob under the known blob roots (`<root>/blobs`, `<root>/actor-assets/blobs`). */
export async function listCachedBlobs(root: string): Promise<CachedBlobEntry[]> {
  const result: CachedBlobEntry[] = [];
  for (const blobs of [path.join(root, 'blobs', 'sha256'), path.join(root, 'actor-assets', 'blobs', 'sha256')]) {
    let prefixes: string[];
    try {
      prefixes = await readdir(blobs);
    } catch {
      continue;
    }
    for (const prefix of prefixes) {
      let names: string[];
      try {
        names = await readdir(path.join(blobs, prefix));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^[0-9a-f]{64}$/.test(name)) continue;
        const file = path.join(blobs, prefix, name);
        try {
          const info = await stat(file);
          result.push({ file, sha256: name, sizeBytes: info.size, lastUsedMs: info.atimeMs, links: info.nlink });
        } catch {
          // Evicted concurrently.
        }
      }
    }
  }
  return result;
}
