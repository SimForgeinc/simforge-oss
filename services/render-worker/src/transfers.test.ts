import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { downloadInputs, type InputDownloadProgress } from './transfers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

it('bounds concurrent downloads, refreshes queued expired URLs, and reuses verified cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'render-inputs-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let active = 0; let peak = 0; let requests = 0; let refreshes = 0;
  const pending: (() => void)[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/refresh') {
      refreshes++;
      expect(request.method).toBe('POST');
      expect(request.headers.authorization).toBe('Bearer scoped');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ url: `${origin}/2`, headers: {}, expiresAt: new Date(Date.now() + 900_000).toISOString() }));
      return;
    }
    requests++; active++; peak = Math.max(peak, active);
    pending.push(() => { active--; response.end(`input-${request.url?.slice(1)}`); });
    if (pending.length === 2 || requests === 5) pending.splice(0).forEach((finish) => finish());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind TCP');
  const origin = `http://127.0.0.1:${address.port}`;
  const inputs = Array.from({ length: 5 }, (_, i) => ({ inputId: `input-${i}`, sha256: createHash('sha256').update(`input-${i}`).digest('hex'), sizeBytes: 7,
    download: i === 2 ? { url: `${origin}/expired`, headers: {}, expiresAt: new Date(0).toISOString(), refresh: { url: `${origin}/refresh`, headers: { authorization: 'Bearer scoped' } } } : { url: `${origin}/${i}`, headers: {} },
  }));
  const progress: InputDownloadProgress[] = [];
  const cache = join(root, 'cache');
  const result = await downloadInputs(inputs, join(root, 'first'), cache, AbortSignal.timeout(5000), { concurrency: 2, progress: async (p) => { progress.push(p); } });
  expect(peak).toBe(2); expect(requests).toBe(5); expect(refreshes).toBe(1);
  expect(await readFile(result.get('input-2')!.path, 'utf8')).toBe('input-2');
  expect(progress.at(-1)).toEqual({ completed: 5, total: 5, downloadedBytes: 35, totalBytes: 35 });
  await downloadInputs(inputs, join(root, 'second'), cache, AbortSignal.timeout(5000), { concurrency: 2 });
  expect(requests).toBe(5); expect(refreshes).toBe(1);
  await writeFile(join(cache, inputs[0]!.sha256), 'corrupt');
  await expect(downloadInputs(inputs, join(root, 'third'), cache, AbortSignal.timeout(5000), { concurrency: 2 })).rejects.toThrow('integrity mismatch');
});

it('rejects duplicate ids before fetching or overwriting any input', async () => {
  const input = { inputId: 'duplicate', sha256: 'a'.repeat(64), sizeBytes: 1, download: { url: 'https://unused.invalid', headers: {} } };
  await expect(downloadInputs([input, input], '/unused', '/unused', new AbortController().signal)).rejects.toThrow('duplicate inputId');
});
