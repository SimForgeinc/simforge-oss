import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { probeGpuMemory, probeGpuMemoryDetailed } from './gpu-memory.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fakeSmi(output: string, exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), 'fake-smi-'));
  roots.push(root);
  const binary = join(root, 'nvidia-smi');
  await writeFile(binary, `#!/bin/sh\nprintf '%s' '${output}'\nexit ${exitCode}\n`);
  await chmod(binary, 0o755);
  return binary;
}

it('reads total and free memory of the visible GPU in bytes', async () => {
  expect(await probeGpuMemory({ binary: await fakeSmi('10240, 9756\n') })).toEqual({ totalBytes: 10240 * 1024 ** 2, freeBytes: 9756 * 1024 ** 2 });
});

it('returns null without usable NVIDIA tooling', async () => {
  expect(await probeGpuMemory({ binary: '/nonexistent/nvidia-smi' })).toBeNull();
  expect(await probeGpuMemory({ binary: await fakeSmi('[N/A], [N/A]\n') })).toBeNull();
  expect(await probeGpuMemory({ binary: await fakeSmi('', 9) })).toBeNull();
});

it('says why nothing was measured', async () => {
  const missing = await probeGpuMemoryDetailed({ binary: '/nonexistent/nvidia-smi' });
  expect('unavailable' in missing && missing.unavailable).toMatch(/not found .*NVIDIA_DRIVER_CAPABILITIES needs utility/);
  const failing = await probeGpuMemoryDetailed({ binary: await fakeSmi('', 9) });
  expect('unavailable' in failing && failing.unavailable).toMatch(/failed/);
  const na = await probeGpuMemoryDetailed({ binary: await fakeSmi('[N/A], [N/A]\n') });
  expect('unavailable' in na && na.unavailable).toMatch(/no usable memory/);
  expect(await probeGpuMemoryDetailed({ binary: await fakeSmi('16303, 8000\n') })).toEqual({ memory: { totalBytes: 16303 * 1024 ** 2, freeBytes: 8000 * 1024 ** 2 } });
});
