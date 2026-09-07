export interface AssetDownloadStats {
  /** Requests whose response bodies are still being read. */
  active: number;
  /** Bytes transferred during the current map/preset load session. */
  transferredBytes: number;
  /** Known total bytes for the session, or null while any active size is unknown. */
  totalBytes: number | null;
  /** Rolling transfer rate while requests are active. */
  bytesPerSecond: number | null;
  /** Time since the most recent response-body chunk while requests are active. */
  stalledForMs: number;
}

type Transfer = {
  generation: number;
  loaded: number;
  total: number | null;
};

type Sample = { at: number; bytes: number };

const RATE_WINDOW_MS = 3_000;
const SAMPLE_INTERVAL_MS = 100;

/**
 * Session-scoped byte telemetry for streamed asset responses.
 *
 * This reports network bytes separately from completed decode work; upload and
 * shader completion counters are maintained by the streaming layers.
 */
export class AssetDownloadTracker {
  private generation = 0;
  private nextId = 1;
  private transfers = new Map<number, Transfer>();
  private transferredBytes = 0;
  private totalBytes = 0;
  private unknownActive = 0;
  private lastProgressAt: number | null = null;
  private samples: Sample[] = [];
  decodedAssets = 0;

  trackDecode(): () => void {
    const generation = this.generation;
    return () => {
      if (generation === this.generation) this.decodedAssets++;
    };
  }

  reset(): void {
    this.generation++;
    this.transfers.clear();
    this.transferredBytes = 0;
    this.totalBytes = 0;
    this.unknownActive = 0;
    this.lastProgressAt = null;
    this.samples = [];
    this.decodedAssets = 0;
  }

  begin(totalBytes?: number | null): number {
    const id = this.nextId++;
    const total = validBytes(totalBytes) ? totalBytes : null;
    this.transfers.set(id, { generation: this.generation, loaded: 0, total });
    if (total === null) this.unknownActive++;
    else this.totalBytes += total;
    return id;
  }

  advance(id: number, chunkBytes: number, now = performance.now()): void {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.generation !== this.generation || !validBytes(chunkBytes)) return;
    transfer.loaded += chunkBytes;
    this.transferredBytes += chunkBytes;
    this.lastProgressAt = now;
    this.recordSample(now);
  }

  finish(id: number, now = performance.now()): void {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.generation !== this.generation) return;
    this.transfers.delete(id);
    if (transfer.total === null) {
      this.unknownActive = Math.max(0, this.unknownActive - 1);
      this.totalBytes += transfer.loaded;
    } else if (transfer.loaded !== transfer.total) {
      // The manifest or Content-Length value is an estimate until the body
      // completes. Reconcile it so completed transfers never leave a false gap.
      this.totalBytes += transfer.loaded - transfer.total;
    }
    this.recordSample(now, true);
  }

  fail(id: number, now = performance.now()): void {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.generation !== this.generation) return;
    this.transfers.delete(id);
    if (transfer.total === null) this.unknownActive = Math.max(0, this.unknownActive - 1);
    else this.totalBytes -= Math.max(0, transfer.total - transfer.loaded);
    this.recordSample(now, true);
  }

  snapshot(now = performance.now()): AssetDownloadStats {
    const active = this.transfers.size;
    const stalledForMs = active > 0 && this.lastProgressAt !== null
      ? Math.max(0, now - this.lastProgressAt)
      : 0;
    return {
      active,
      transferredBytes: this.transferredBytes,
      totalBytes: this.unknownActive > 0 ? null : this.totalBytes,
      bytesPerSecond: active > 0 ? this.rate(now, stalledForMs) : null,
      stalledForMs,
    };
  }

  private recordSample(now: number, force = false): void {
    const latest = this.samples.at(-1);
    if (!latest || force || now - latest.at >= SAMPLE_INTERVAL_MS) {
      this.samples.push({ at: now, bytes: this.transferredBytes });
    } else {
      latest.at = now;
      latest.bytes = this.transferredBytes;
    }
    const cutoff = now - RATE_WINDOW_MS;
    while (this.samples.length > 2 && (this.samples[1]?.at ?? now) < cutoff) {
      this.samples.shift();
    }
  }

  private rate(now: number, stalledForMs: number): number | null {
    if (stalledForMs >= RATE_WINDOW_MS) return 0;
    const samples = this.samples.filter((sample) => sample.at >= now - RATE_WINDOW_MS);
    const first = samples[0];
    const last = samples.at(-1);
    if (!first || !last || last.at <= first.at || last.bytes <= first.bytes) return null;
    return ((last.bytes - first.bytes) * 1_000) / (last.at - first.at);
  }
}

function validBytes(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export async function readResponseBufferWithProgress(
  response: Response,
  tracker: AssetDownloadTracker,
  expectedBytes?: number | null,
): Promise<ArrayBuffer> {
  const headerBytes = Number(response.headers.get('content-length'));
  const id = tracker.begin(validBytes(headerBytes) ? headerBytes : expectedBytes);
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      const buffer = await response.arrayBuffer();
      tracker.advance(id, buffer.byteLength);
      tracker.finish(id);
      return buffer;
    } catch (error) {
      tracker.fail(id);
      throw error;
    }
  }

  // A trustworthy uncompressed Content-Length avoids retaining every chunk
  // plus a second full-size concatenation buffer for large GLBs.
  let output = validBytes(headerBytes) && !response.headers.get('content-encoding')
    ? new Uint8Array(headerBytes) : null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (output && length + value.byteLength <= output.byteLength) {
        output.set(value, length);
      } else {
        if (output) {
          chunks.push(output.subarray(0, length));
          output = null;
        }
        chunks.push(value);
      }
      length += value.byteLength;
      tracker.advance(id, value.byteLength);
    }
    if (!output) {
      output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    tracker.finish(id);
    return length === output.byteLength ? output.buffer : output.buffer.slice(0, length);
  } catch (error) {
    tracker.fail(id);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
