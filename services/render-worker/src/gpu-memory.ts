import { execFile } from 'node:child_process';

export interface GpuMemory {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

/**
 * The GPU this worker renders on, as the driver reports it right now:
 * `nvidia-smi` inside the container sees only its visible device(s). Free
 * memory includes every co-tenant's residency on a shared card (another
 * environment's idle service, a desktop, a benchmark run). Null when there
 * is no NVIDIA tooling (the engine then keeps its declared assumption).
 */
export function probeGpuMemory(options: { readonly binary?: string; readonly index?: number; readonly timeoutMs?: number } = {}): Promise<GpuMemory | null> {
  return new Promise((resolve) => {
    execFile(
      options.binary ?? 'nvidia-smi',
      ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: options.timeoutMs ?? 5000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const rows = stdout.trim().split('\n').map((line) => line.split(',').map((cell) => Number(cell.trim())));
        const row = rows[options.index ?? 0];
        if (!row || row.length < 2 || !row.every((value) => Number.isFinite(value) && value >= 0)) return resolve(null);
        resolve({ totalBytes: row[0]! * 1024 * 1024, freeBytes: row[1]! * 1024 * 1024 });
      },
    );
  });
}
