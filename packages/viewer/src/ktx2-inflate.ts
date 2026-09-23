/**
 * Inflate the zstd-supercompressed KTX2 members of a browser-pack texture
 * chunk on a worker pool.
 *
 * Ingest cooks every texture tier to the GPU's own block format (BC7, ASTC,
 * ETC2) with zstd supercompression and prebuilt mips, so the client never
 * transcodes. The only CPU work left is the inflate. Three's KTX2Loader does
 * that on the main thread (`createRawTexture`), a few hundred milliseconds of
 * main-thread time per map. Here each chunk goes to a worker once: every KTX2
 * member is rewritten with supercompression NONE (identical vkFormat, data
 * format descriptor, dimensions and level data), so the main thread's parse is
 * a header read and the texture it builds is exactly what KTX2Loader would have
 * built from the compressed file.
 *
 * The worker loads `ktx-parse.module.js` and `zstddec.module.js` from the same
 * runtime directory as the Basis transcoder (the studio serves both under
 * `/basis/`). A missing runtime rejects every inflate with the load error.
 */

interface Job {
  resolve: (value: { buffer: ArrayBuffer; ranges: ReadonlyMap<string, readonly [number, number]> }) => void;
  reject: (error: Error) => void;
}

const WORKER_SOURCE = (runtime: string): string => `
let ready = null, failure = null;
const queue = [];
self.onmessage = (event) => { if (ready) handle(event.data); else if (failure) fail(event.data, failure); else queue.push(event.data); };
function fail(message, error) { self.postMessage({ id: message.id, error: String(error && error.message || error) }); }
(async () => {
  const { read, write } = await import(${JSON.stringify(`${runtime}ktx-parse.module.js`)});
  const { ZSTDDecoder } = await import(${JSON.stringify(`${runtime}zstddec.module.js`)});
  const zstd = new ZSTDDecoder();
  await zstd.init();
  ready = { read, write, zstd };
  for (const message of queue.splice(0)) handle(message);
})().catch((error) => { failure = error; for (const message of queue.splice(0)) fail(message, error); });
function handle(message) {
  try {
    const { read, write, zstd } = ready;
    const source = new Uint8Array(message.buffer);
    const parts = [];
    const ranges = [];
    let total = 0;
    for (const member of message.members) {
      let bytes = source.subarray(member.offset, member.offset + member.length);
      if (member.path.endsWith('.ktx2')) {
        const container = read(bytes);
        if (container.supercompressionScheme === 2) {
          for (const level of container.levels) level.levelData = zstd.decode(level.levelData, level.uncompressedByteLength);
          container.supercompressionScheme = 0;
          bytes = write(container);
        } else if (container.supercompressionScheme !== 0) {
          throw new Error('unsupported KTX2 supercompression ' + container.supercompressionScheme + ' in ' + member.path);
        }
      }
      ranges.push([member.path, total, bytes.byteLength]);
      parts.push(bytes);
      total += bytes.byteLength;
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
    self.postMessage({ id: message.id, buffer: output.buffer, ranges }, [output.buffer]);
  } catch (error) { fail(message, error); }
}
`;

export class Ktx2InflatePool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly waiting: (() => void)[] = [];
  private readonly jobs = new Map<number, Job>();
  private nextId = 1;
  private readonly url: string;
  private disposed = false;

  constructor(runtimePath: string, size = defaultInflateWorkers()) {
    const runtime = new URL(runtimePath, typeof document !== 'undefined' ? document.baseURI : undefined).href;
    this.url = URL.createObjectURL(new Blob([WORKER_SOURCE(runtime.endsWith('/') ? runtime : `${runtime}/`)], { type: 'text/javascript' }));
    for (let i = 0; i < size; i++) {
      const worker = new Worker(this.url, { type: 'module', name: `ktx2-inflate-${i}` });
      worker.onmessage = (event: MessageEvent<{ id: number; buffer?: ArrayBuffer; ranges?: [string, number, number][]; error?: string }>) => {
        const { id, buffer, ranges, error } = event.data;
        const job = this.jobs.get(id);
        this.jobs.delete(id);
        this.release(worker);
        if (!job) return;
        if (error || !buffer || !ranges) job.reject(new Error(`KTX2 inflate failed: ${error ?? 'no output'}`));
        else job.resolve({ buffer, ranges: new Map(ranges.map(([path, start, length]) => [path, [start, length] as const])) });
      };
      worker.onerror = (event) => {
        for (const [id, job] of this.jobs) { this.jobs.delete(id); job.reject(new Error(`KTX2 inflate worker failed: ${event.message}`)); }
      };
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  private release(worker: Worker): void {
    this.idle.push(worker);
    this.waiting.shift()?.();
  }

  private async acquire(): Promise<Worker> {
    while (this.idle.length === 0) await new Promise<void>((resolve) => this.waiting.push(resolve));
    return this.idle.pop()!;
  }

  /** Inflate the KTX2 members of one chunk. The input buffer is transferred (detached). */
  async inflate(buffer: ArrayBuffer, members: readonly { path: string; offset: number; length: number }[]) {
    if (this.disposed) throw new Error('KTX2 inflate pool is disposed');
    const worker = await this.acquire();
    const id = this.nextId++;
    return new Promise<{ buffer: ArrayBuffer; ranges: ReadonlyMap<string, readonly [number, number]> }>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      worker.postMessage({ id, buffer, members: [...members].sort((a, b) => a.offset - b.offset) }, [buffer]);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const worker of this.workers) worker.terminate();
    for (const job of this.jobs.values()) job.reject(new Error('KTX2 inflate pool disposed'));
    this.jobs.clear();
    URL.revokeObjectURL(this.url);
  }
}

export function defaultInflateWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4;
  return Math.min(8, Math.max(2, cores - 2));
}
