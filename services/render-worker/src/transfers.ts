import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  InputDownloadSchema,
  INPUT_URLS_MAX_BATCH,
  throwIfCanceled,
  type InputDownload,
  type JobInputTransfer,
  type RenderEngineAdapter,
  type RenderInputFile,
} from '@simforge-oss/render';
import type { RenderIntentV1 } from '@simforge-oss/scenario';

import type { BlobSource, BlobStore } from './blob-store.js';

function safeInputName(inputId: string): string {
  const stem = inputId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'input';
  const suffix = createHash('sha256').update(inputId).digest('hex').slice(0, 12);
  return `${stem}-${suffix}`;
}

export type InputDownloadProgress = { completed: number; total: number; downloadedBytes: number; totalBytes: number };

export interface InputDownloadSummary {
  readonly declared: number;
  readonly declaredBytes: number;
  readonly selected: number;
  readonly selectedBytes: number;
  readonly cacheHits: number;
  readonly cacheHitBytes: number;
  readonly fetchedBytes: number;
  readonly selectMs: number;
  readonly fetchMs: number;
  readonly elapsedMs: number;
}

export interface DownloadInputsOptions {
  /** Engine hook: which claimed inputs this intent renders from (default: all). */
  readonly selectInputs?: RenderEngineAdapter['selectInputs'];
  readonly intent?: RenderIntentV1;
  /** `cache`: return paths inside the read-only blob cache; `workspace`: link/copy under `<workspace>/inputs`. */
  readonly placement?: 'cache' | 'workspace';
  /** Batch URL signer for inputs the lease sent without a URL. */
  readonly inputUrls?: (inputIds: readonly string[], signal: AbortSignal) => Promise<Readonly<Record<string, InputDownload>>>;
  readonly progress?: (progress: InputDownloadProgress) => Promise<void> | void;
  readonly log?: (event: Record<string, unknown>) => void;
}

async function refreshedDownload(download: InputDownload, inputId: string, signal: AbortSignal): Promise<InputDownload> {
  if (!download.refresh) throw new Error(`input ${inputId} URL expired; refresh unavailable`);
  const response = await fetch(download.refresh.url, { method: 'POST', headers: download.refresh.headers, redirect: 'error', signal });
  if (!response.ok) throw new Error(`input ${inputId} refresh returned ${response.status}`);
  const refreshed = InputDownloadSchema.parse(await response.json());
  return { ...refreshed, ...(refreshed.refresh || !download.refresh ? {} : { refresh: download.refresh }) };
}

/**
 * Hands out one URL per input: the lease's own (refreshed when it is about
 * to expire or was refused), or, for inputs the lease sent without a URL,
 * one signed in a batch with every other miss that asked in the same tick.
 */
class InputUrlBook {
  private readonly downloads = new Map<string, InputDownload>();
  private pending = new Map<string, Array<{ resolve: (download: InputDownload) => void; reject: (error: unknown) => void }>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    transfers: readonly JobInputTransfer[],
    private readonly signer: DownloadInputsOptions['inputUrls'],
    private readonly signal: AbortSignal,
  ) {
    for (const transfer of transfers) if (transfer.download) this.downloads.set(transfer.inputId, transfer.download);
  }

  source(inputId: string): BlobSource {
    return {
      url: async (refresh) => {
        let download = this.downloads.get(inputId);
        const expiring = download?.expiresAt !== undefined && Date.parse(download.expiresAt) - Date.now() <= 120_000;
        if (download && (refresh || expiring)) {
          download = download.refresh
            ? await refreshedDownload(download, inputId, this.signal)
            : this.signer ? await this.sign(inputId) : download;
          if (expiring && !download.refresh && !this.signer && download.expiresAt && Date.parse(download.expiresAt) - Date.now() <= 120_000) {
            throw new Error(`input ${inputId} URL expires before download; refresh unavailable`);
          }
          this.downloads.set(inputId, download);
        } else if (!download) {
          download = await this.sign(inputId);
          this.downloads.set(inputId, download);
        }
        return { url: download.url, headers: download.headers };
      },
    };
  }

  /** Signs every listed input that has no usable URL, in batches. */
  async prefetch(inputIds: readonly string[]): Promise<void> {
    const missing = inputIds.filter((inputId) => !this.downloads.has(inputId));
    await Promise.all(missing.map((inputId) => this.sign(inputId).then((download) => this.downloads.set(inputId, download))));
  }

  private sign(inputId: string): Promise<InputDownload> {
    if (!this.signer) return Promise.reject(new Error(`input ${inputId} has no download URL and the control plane cannot sign one`));
    return new Promise((resolve, reject) => {
      const waiters = this.pending.get(inputId) ?? [];
      waiters.push({ resolve, reject });
      this.pending.set(inputId, waiters);
      if (!this.timer) this.timer = setTimeout(() => void this.flush(), 20);
    });
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const batch = this.pending;
    this.pending = new Map();
    const ids = [...batch.keys()];
    for (let start = 0; start < ids.length; start += INPUT_URLS_MAX_BATCH) {
      const chunk = ids.slice(start, start + INPUT_URLS_MAX_BATCH);
      try {
        const signed = await this.signer!(chunk, this.signal);
        for (const inputId of chunk) {
          const download = signed[inputId];
          for (const waiter of batch.get(inputId)!) {
            if (download) waiter.resolve(download);
            else waiter.reject(new Error(`control plane did not sign input ${inputId}`));
          }
        }
      } catch (error) {
        for (const inputId of chunk) for (const waiter of batch.get(inputId)!) waiter.reject(error);
      }
    }
  }
}

async function placeInWorkspace(blobPath: string, target: string, sizeBytes: number): Promise<void> {
  await rm(target, { force: true });
  try {
    await link(blobPath, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM') throw error;
    await copyFile(blobPath, target);
    const copied = await stat(target);
    if (copied.size !== sizeBytes) throw new Error(`input copy size mismatch for ${basename(target)}`);
  }
}

/**
 * Makes a job's inputs available: asks the engine which inputs it renders
 * from, serves every cached one from the content-addressed blob store (no
 * copy, no re-hash beyond its verification stamp), fetches the misses at job
 * priority, and reports progress. Failures of the progress callback never
 * fail the download.
 */
export async function downloadInputs(
  transfers: readonly JobInputTransfer[],
  workspace: string,
  store: BlobStore,
  signal: AbortSignal,
  options: DownloadInputsOptions = {},
): Promise<ReadonlyMap<string, RenderInputFile> & { summary?: InputDownloadSummary }> {
  const log = options.log ?? ((event) => console.error(JSON.stringify(event)));
  const byId = new Map<string, JobInputTransfer>();
  for (const transfer of transfers) {
    if (byId.has(transfer.inputId)) throw new Error(`duplicate inputId ${transfer.inputId}`);
    byId.set(transfer.inputId, transfer);
  }
  const startedAt = Date.now();
  const storeBytesAtStart = store.stats().downloadedBytes;
  const urls = new InputUrlBook(transfers, options.inputUrls, signal);
  const hits = new Set<string>();
  const ensure = async (transfer: JobInputTransfer, onBytes?: (bytes: number) => void): Promise<string> => {
    throwIfCanceled(signal);
    if (await store.has(transfer.sha256, transfer.sizeBytes)) {
      hits.add(transfer.inputId);
      return store.path(transfer.sha256);
    }
    return store.ensure({
      sha256: transfer.sha256,
      sizeBytes: transfer.sizeBytes,
      source: urls.source(transfer.inputId),
      priority: 'job',
      ...(onBytes ? { onBytes } : {}),
    }, signal);
  };

  // 1. Selection: the engine may read a few small inputs (a map master and
  //    its manifests) to decide which of the rest it needs.
  let selectedIds: ReadonlySet<string> = new Set(byId.keys());
  if (options.selectInputs && options.intent) {
    selectedIds = await options.selectInputs({
      intent: options.intent,
      inputs: transfers.map(({ inputId, relativePath, sha256, sizeBytes }) => ({ inputId, ...(relativePath === undefined ? {} : { relativePath }), sha256, sizeBytes })),
      read: async (inputId) => {
        const transfer = byId.get(inputId);
        if (!transfer) throw new Error(`engine asked for unclaimed input ${inputId}`);
        return readFile(await ensure(transfer));
      },
      signal,
    });
    for (const inputId of selectedIds) if (!byId.has(inputId)) throw new Error(`engine selected unclaimed input ${inputId}`);
  }
  const selected = transfers.filter((transfer) => selectedIds.has(transfer.inputId));
  const selectMs = Date.now() - startedAt;

  // 2. Fetch. Presence first (one stat per blob), then batch-sign the misses
  //    that have no lease URL before any lane opens.
  const totalBytes = selected.reduce((sum, input) => sum + input.sizeBytes, 0);
  const missing: JobInputTransfer[] = [];
  let cachedBytes = 0;
  await Promise.all(selected.map(async (transfer) => {
    if (await store.has(transfer.sha256, transfer.sizeBytes)) {
      hits.add(transfer.inputId);
      cachedBytes += transfer.sizeBytes;
    } else {
      missing.push(transfer);
    }
  }));
  if (options.inputUrls) await urls.prefetch(missing.filter((transfer) => !transfer.download).map((transfer) => transfer.inputId));

  let completed = selected.length - missing.length;
  let downloadedBytes = cachedBytes;
  let lastReport = 0;
  let reporting: Promise<void> | undefined;
  const report = (force = false) => {
    if (!options.progress) return;
    if (!force && (reporting || Date.now() - lastReport < 1000)) return;
    lastReport = Date.now();
    const snapshot = { completed, total: selected.length, downloadedBytes: Math.min(downloadedBytes, totalBytes), totalBytes };
    // Progress is best effort and never blocks a download lane.
    reporting = Promise.resolve()
      .then(() => options.progress!(snapshot))
      .catch((error: unknown) => log({ event: 'inputs.progress_failed', error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { reporting = undefined; });
  };
  report(true);

  const fetchStarted = Date.now();
  const paths = new Map<string, string>();
  for (const transfer of selected) if (hits.has(transfer.inputId)) paths.set(transfer.inputId, store.path(transfer.sha256));
  const controller = new AbortController();
  const jobSignal = AbortSignal.any([signal, controller.signal]);
  // Larger blobs first: they dominate wall time and overlap the small tail.
  missing.sort((left, right) => right.sizeBytes - left.sizeBytes);
  await Promise.all(missing.map(async (transfer) => {
    try {
      let credited = 0;
      const path = await store.ensure({
        sha256: transfer.sha256,
        sizeBytes: transfer.sizeBytes,
        source: urls.source(transfer.inputId),
        priority: 'job',
        onBytes: (bytes) => {
          credited += bytes;
          downloadedBytes += bytes;
          report();
        },
      }, jobSignal);
      downloadedBytes += transfer.sizeBytes - credited;
      paths.set(transfer.inputId, path);
      completed += 1;
      report();
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  })).catch((error: unknown) => {
    throw controller.signal.reason ?? error;
  });
  report(true);
  await reporting;

  // 3. Placement.
  const result = new Map<string, RenderInputFile>() as Map<string, RenderInputFile> & { summary?: InputDownloadSummary };
  const inputDir = join(workspace, 'inputs');
  if (options.placement !== 'cache') await mkdir(inputDir, { recursive: true });
  for (const transfer of selected) {
    const blobPath = paths.get(transfer.inputId)!;
    let path = blobPath;
    if (options.placement !== 'cache') {
      path = join(inputDir, safeInputName(transfer.inputId));
      await placeInWorkspace(blobPath, path, transfer.sizeBytes);
    }
    result.set(transfer.inputId, {
      inputId: transfer.inputId,
      path,
      sha256: transfer.sha256,
      sizeBytes: transfer.sizeBytes,
      ...(transfer.relativePath === undefined ? {} : { relativePath: transfer.relativePath }),
    });
  }
  const summary: InputDownloadSummary = {
    declared: transfers.length,
    declaredBytes: transfers.reduce((sum, input) => sum + input.sizeBytes, 0),
    selected: selected.length,
    selectedBytes: totalBytes,
    cacheHits: [...hits].filter((inputId) => selectedIds.has(inputId)).length,
    cacheHitBytes: cachedBytes,
    fetchedBytes: store.stats().downloadedBytes - storeBytesAtStart,
    selectMs,
    fetchMs: Date.now() - fetchStarted,
    elapsedMs: Date.now() - startedAt,
  };
  result.summary = summary;
  log({ event: 'inputs.ready', ...summary });
  return result;
}

export async function uploadFile(
  url: string,
  headers: Readonly<Record<string, string>>,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const size = (await stat(path)).size;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'content-length': String(size) },
    body: createReadStream(path),
    duplex: 'half',
    signal,
  } as unknown as RequestInit & { duplex: 'half' });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`artifact upload returned ${response.status}: ${text.slice(0, 2048)}`);
  }
}
