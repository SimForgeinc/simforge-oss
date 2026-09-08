export interface AssetDownloadStats {
  /** Network requests whose response bodies are still being read (excludes cache). */
  active: number;
  /** Network response-body bytes read during the current map load session. */
  transferredBytes: number;
  /** Response-body bytes read from the host's persistent asset cache. */
  cachedBytes: number;
  /** Whether the viewer has settled the currently selected asset scope. */
  discoveryComplete: boolean;
  /** Final network body bytes, or null while the selected scope is still loading. */
  totalBytes: number | null;
  /** Rolling transfer rate while requests are active. */
  bytesPerSecond: number | null;
  /** Time since the most recent response-body chunk while requests are active. */
  stalledForMs: number;
}

type Transfer = {
  generation: number;
  cached: boolean;
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
  private cachedBytes = 0;
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
    this.cachedBytes = 0;
    this.lastProgressAt = null;
    this.samples = [];
    this.decodedAssets = 0;
  }

  /** Capture before fetching so a late response cannot enter a newer session. */
  get sessionId(): number {
    return this.generation;
  }

  begin(cached = false, sessionId = this.generation): number {
    if (sessionId !== this.generation) return -1;
    const id = this.nextId++;
    this.transfers.set(id, { generation: this.generation, cached });
    return id;
  }

  advance(id: number, chunkBytes: number, now = performance.now()): void {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.generation !== this.generation || !validBytes(chunkBytes)) return;
    if (transfer.cached) {
      this.cachedBytes += chunkBytes;
    } else {
      this.transferredBytes += chunkBytes;
      this.lastProgressAt = now;
      this.recordSample(now);
    }
  }

  finish(id: number, now = performance.now()): void {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.generation !== this.generation) return;
    this.transfers.delete(id);
    if (!transfer.cached) this.recordSample(now, true);
  }

  fail(id: number, now = performance.now()): void {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.generation !== this.generation) return;
    this.transfers.delete(id);
    if (!transfer.cached) this.recordSample(now, true);
  }

  snapshot(now = performance.now(), scopeSettled = false): AssetDownloadStats {
    let active = 0;
    for (const transfer of this.transfers.values()) {
      if (!transfer.cached) active++;
    }
    const discoveryComplete = scopeSettled && this.transfers.size === 0;
    const stalledForMs = active > 0 && this.lastProgressAt !== null
      ? Math.max(0, now - this.lastProgressAt)
      : 0;
    return {
      active,
      transferredBytes: this.transferredBytes,
      cachedBytes: this.cachedBytes,
      discoveryComplete,
      totalBytes: discoveryComplete ? this.transferredBytes : null,
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
  sessionId = tracker.sessionId,
): Promise<ArrayBuffer> {
  const headerBytes = Number(response.headers.get('content-length'));
  const id = tracker.begin(response.headers.get('x-simforge-cache') === 'hit', sessionId);
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

  // Uncompressed size metadata can avoid retaining every chunk plus a second
  // concatenation buffer. Mismatched estimates still fall back to chunk assembly.
  const allocationBytes = validBytes(headerBytes) ? headerBytes : expectedBytes;
  let output = validBytes(allocationBytes) && !response.headers.get('content-encoding')
    ? new Uint8Array(allocationBytes) : null;
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
