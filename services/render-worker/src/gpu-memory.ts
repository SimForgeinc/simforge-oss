import { execFile } from 'node:child_process';

export interface GpuMemory {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

/**
 * The GPU this worker renders on, as the driver reports it right now:
 * `nvidia-smi` inside the container sees only its visible device(s). Free
 * memory includes every co-tenant's residency on a shared card (another
 * environment's idle service, a desktop, a benchmark run). `unavailable`
 * says why nothing was measured (no NVIDIA tooling in the container, a
 * failing or slow `nvidia-smi`, unparseable output): the job reports it
 * instead of silently rendering on an assumed capacity.
 */
export async function probeGpuMemoryDetailed(options: { readonly binary?: string; readonly index?: number; readonly timeoutMs?: number } = {}): Promise<{ readonly memory: GpuMemory } | { readonly unavailable: string }> {
  const binary = options.binary ?? 'nvidia-smi';
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    execFile(
      binary,
      ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const reason = code === 'ENOENT' ? `${binary} not found (no NVIDIA utility tooling in the container: NVIDIA_DRIVER_CAPABILITIES needs utility)`
            : error.killed ? `${binary} did not answer within ${timeoutMs} ms`
            : `${binary} failed: ${(String(stderr).trim() || error.message).slice(0, 200)}`;
          return resolve({ unavailable: reason });
        }
        const rows = stdout.trim().split('\n').map((line) => line.split(',').map((cell) => Number(cell.trim())));
        const row = rows[options.index ?? 0];
        if (!row || row.length < 2 || !row.every((value) => Number.isFinite(value) && value >= 0)) {
          return resolve({ unavailable: `${binary} printed no usable memory for GPU ${options.index ?? 0}: ${JSON.stringify(stdout.trim().slice(0, 120))}` });
        }
        resolve({ memory: { totalBytes: row[0]! * 1024 * 1024, freeBytes: row[1]! * 1024 * 1024 } });
      },
    );
  });
}

/** `probeGpuMemoryDetailed` without the reason: null when nothing was measured. */
export async function probeGpuMemory(options: { readonly binary?: string; readonly index?: number; readonly timeoutMs?: number } = {}): Promise<GpuMemory | null> {
  const probe = await probeGpuMemoryDetailed(options);
  return 'memory' in probe ? probe.memory : null;
}
