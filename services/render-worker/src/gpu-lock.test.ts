import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { acquireGpuJobLock, clearStaleGpuLock, staleGpuLockReason } from './gpu-lock.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function lockPath() {
  const root = await mkdtemp(join(tmpdir(), 'gpu-lock-'));
  roots.push(root);
  await mkdir(join(root, 'run'));
  return join(root, 'run', 'gpu.lock');
}

it('a restarted worker clears the lock its previous process left, even with the same pid', async () => {
  const path = await lockPath();
  // The incident: the dead container's worker was pid 51, and so is the new one.
  const first = await acquireGpuJobLock(path, 'usrj_attempt2', { refreshMs: 60_000 });
  const leftover = await readFile(path, 'utf8');
  await first.release();
  await writeFile(path, leftover); // the process died without releasing
  expect(await staleGpuLockReason(path)).toMatch(/previous process/);
  const next = await acquireGpuJobLock(path, 'usrj_attempt3', { waitMs: 1000 });
  expect(JSON.parse(await readFile(path, 'utf8')).jobId).toBe('usrj_attempt3');
  await next.release();
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('clears a legacy-format leftover naming one of this worker\'s own earlier jobs at startup', async () => {
  const path = await lockPath();
  await writeFile(path, JSON.stringify({ pid: 51, jobId: 'usrj_0272cd18', acquiredAt: new Date().toISOString() }));
  expect(await clearStaleGpuLock(path, { isJobActive: async () => true })).toBeNull();
  expect(await clearStaleGpuLock(path, { isJobActive: async (jobId) => jobId !== 'usrj_0272cd18' })).toMatch(/no longer active/);
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('honours a live lock held by another container and waits for it instead of failing', async () => {
  const path = await lockPath();
  // Another worker (different host identity) holds the GPU and keeps refreshing.
  await writeFile(path, JSON.stringify({ pid: 51, host: `${hostname()}-other`, token: 'other', jobId: 'usrj_staging', acquiredAt: new Date().toISOString() }));
  expect(await staleGpuLockReason(path)).toBeNull();
  const waits: string[] = [];
  const pending = acquireGpuJobLock(path, 'usrj_dev', { pollMs: 20, waitMs: 5000, onWait: (owner) => waits.push(String(owner.jobId)) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(path); // the other job finishes
  const lock = await pending;
  expect(waits[0]).toBe('usrj_staging');
  await lock.release();
});

it('treats a lock whose holder stopped refreshing as stale, and a fresh legacy lock as live', async () => {
  const path = await lockPath();
  await writeFile(path, JSON.stringify({ pid: 999999, host: 'elsewhere', token: 't', jobId: 'usrj_dead' }));
  const old = new Date(Date.now() - 120_000);
  await utimes(path, old, old);
  expect(await staleGpuLockReason(path)).toMatch(/not refreshed/);
  await writeFile(path, JSON.stringify({ pid: 999999, jobId: 'usrj_legacy' }));
  expect(await staleGpuLockReason(path)).toBeNull();
  await expect(acquireGpuJobLock(path, 'usrj_x', { waitMs: 50, pollMs: 10 })).rejects.toThrow(/GPU is locked by job usrj_legacy/);
});
