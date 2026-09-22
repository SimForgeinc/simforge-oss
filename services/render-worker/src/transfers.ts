import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { hashFile, throwIfCanceled, type RenderInputFile } from '@simforge-oss/render';
import { JobInputTransferSchema, type JobInputTransfer } from '@simforge-oss/render';

function safeInputName(inputId: string): string {
  const stem = inputId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'input';
  const suffix = createHash('sha256').update(inputId).digest('hex').slice(0, 12);
  return `${stem}-${suffix}`;
}

async function verifyFile(path: string, expectedSha256: string, expectedSize: number): Promise<void> {
  const actual = await hashFile(path);
  if (actual.sha256 !== expectedSha256 || actual.sizeBytes !== expectedSize) {
    throw new Error(`transfer integrity mismatch for ${basename(path)}: expected ${expectedSha256}/${expectedSize}, got ${actual.sha256}/${actual.sizeBytes}`);
  }
}

export type InputDownloadProgress = { completed: number; total: number; downloadedBytes: number; totalBytes: number };

async function freshDownload(transfer: JobInputTransfer, signal: AbortSignal): Promise<JobInputTransfer['download']> {
  const download = transfer.download;
  if (!download.expiresAt || Date.parse(download.expiresAt) - Date.now() > 120_000) return download;
  if (!download.refresh) throw new Error(`input ${transfer.inputId} URL expires before download; refresh unavailable`);
  const response = await fetch(download.refresh.url, { method: 'POST', headers: download.refresh.headers, redirect: 'error', signal });
  if (!response.ok) throw new Error(`input ${transfer.inputId} refresh returned ${response.status}`);
  const refreshed = JobInputTransferSchema.shape.download.parse(await response.json());
  if (!refreshed.expiresAt || Date.parse(refreshed.expiresAt) - Date.now() <= 120_000) {
    throw new Error(`input ${transfer.inputId} refresh did not extend expiry`);
  }
  return refreshed;
}

export async function downloadInputs(
  transfers: readonly JobInputTransfer[],
  workspace: string,
  cacheDir: string,
  signal: AbortSignal,
  options: { concurrency?: number; progress?: (progress: InputDownloadProgress) => Promise<void> } = {},
): Promise<ReadonlyMap<string, RenderInputFile>> {
  const concurrency = options.concurrency ?? Number(process.env.SIMFORGE_INPUT_DOWNLOAD_CONCURRENCY ?? 16);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) throw new Error('input download concurrency must be an integer from 1 to 128');
  const ids = new Set<string>();
  for (const transfer of transfers) {
    if (ids.has(transfer.inputId)) throw new Error(`duplicate inputId ${transfer.inputId}`);
    ids.add(transfer.inputId);
  }
  const controller = new AbortController();
  signal = AbortSignal.any([signal, controller.signal]);
  const startedAt = Date.now();
  const totalBytes = transfers.reduce((sum, input) => sum + input.sizeBytes, 0);
  let downloadedBytes = 0;
  let next = 0;
  let lastReport = 0;
  let progressTail = Promise.resolve();
  const report = (completed: number) => {
    if (completed !== transfers.length && completed !== 0 && Date.now() - lastReport < 1000) return;
    lastReport = Date.now();
    const snapshot = { completed, total: transfers.length, downloadedBytes, totalBytes };
    progressTail = progressTail.then(() => options.progress?.(snapshot));
    return progressTail;
  };
  const inputDir = join(workspace, 'inputs');
  await mkdir(inputDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const result = new Map<string, RenderInputFile>();

  await report(0);
  const materialize = async (transfer: JobInputTransfer) => {
    throwIfCanceled(signal);
    const cachePath = join(cacheDir, transfer.sha256);
    let cacheValid = false;
    try {
      const cached = await stat(cachePath);
      cacheValid = cached.isFile() && cached.size === transfer.sizeBytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (!cacheValid) {
      const temporaryPath = `${cachePath}.${randomUUID()}.part`;
      const download = await freshDownload(transfer, signal);
      const response = await fetch(download.url, { headers: download.headers, redirect: 'error', signal });
      if (!response.ok || !response.body) throw new Error(`input ${transfer.inputId} download returned ${response.status}`);
      const digest = createHash('sha256');
      let sizeBytes = 0;
      const hashingStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(response.body as never), hashingStream, createWriteStream(temporaryPath, { mode: 0o600 }), { signal });
        const sha256 = digest.digest('hex');
        if (sha256 !== transfer.sha256 || sizeBytes !== transfer.sizeBytes) {
          throw new Error(`input ${transfer.inputId} integrity mismatch: expected ${transfer.sha256}/${transfer.sizeBytes}, got ${sha256}/${sizeBytes}`);
        }
        await rename(temporaryPath, cachePath).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
          await rm(temporaryPath, { force: true });
        });
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    }

    const localPath = join(inputDir, safeInputName(transfer.inputId));
    await copyFile(cachePath, localPath);
    try {
      await verifyFile(localPath, transfer.sha256, transfer.sizeBytes);
    } catch (error) {
      await Promise.all([rm(cachePath, { force: true }), rm(localPath, { force: true })]);
      throw error;
    }
    result.set(transfer.inputId, { inputId: transfer.inputId, path: localPath, sha256: transfer.sha256, sizeBytes: transfer.sizeBytes, ...(transfer.relativePath === undefined ? {} : { relativePath: transfer.relativePath }) });
    downloadedBytes += transfer.sizeBytes;
    await report(result.size);
  };
  const run = async () => {
    try {
      while (next < transfers.length) {
        const transfer = transfers[next++]!;
        await materialize(transfer);
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, transfers.length) }, run));
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed?.status === 'rejected') throw controller.signal.reason ?? failed.reason;
  await progressTail;
  console.error(JSON.stringify({ event: 'inputs.ready', files: result.size, bytes: downloadedBytes, elapsedMs: Date.now() - startedAt, concurrency }));
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
