/**
 * Independent evidence that a load is alive.
 *
 * The loading host used to judge liveness only from what a publisher reported:
 * a byte-identical source for 45 s was declared stalled. Before a viewer
 * exists there is nothing to report yet — route chunks, the map manifest and
 * the first sidecars are in flight with no publisher attached — so a healthy
 * load of a multi-gigabyte map was replaced by an error that told the user to
 * reload a load that was working.
 *
 * `PerformanceObserver` sees those bytes whoever fetched them, so the watchdog
 * can ask the browser instead of trusting a string.
 */

export type TransferSnapshot = {
  /** Bytes the browser has accounted for since the observer started. */
  readonly bytes: number;
  /** Responses completed since the observer started. */
  readonly responses: number;
  /** `performance.now()` of the last completed response, or null if none. */
  readonly lastAt: number | null;
};

const EMPTY: TransferSnapshot = { bytes: 0, responses: 0, lastAt: null };
export type TransferObserver = {
  snapshot(): TransferSnapshot;
  dispose(): void;
};

/**
 * Watch completed responses. Returns a no-op observer where resource timing is
 * unavailable, so callers never branch on support; a watchdog then falls back
 * to whatever its publishers report, exactly as before.
 */
export function observeTransfers(onProgress?: (snapshot: TransferSnapshot) => void): TransferObserver {
  if (typeof PerformanceObserver === "undefined") {
    return { snapshot: () => EMPTY, dispose: () => undefined };
  }
  let bytes = 0;
  let responses = 0;
  let lastAt: number | null = null;
  const observer = new PerformanceObserver((list) => {
    let changed = false;
    for (const entry of list.getEntries()) {
      if (entry.entryType !== "resource") continue;
      const resource = entry as PerformanceResourceTiming;
      // Long-polling dev sockets and the HMR channel never settle; counting
      // them would make every idle page look alive.
      if (resource.initiatorType === "eventsource" || resource.initiatorType === "websocket") continue;
      // Resource timing reports 0 for a cross-origin response without
      // `Timing-Allow-Origin` and for a cached one; any non-zero size proves
      // the response carried a body, which is all liveness needs.
      bytes += Math.max(resource.transferSize ?? 0, resource.encodedBodySize ?? 0, resource.decodedBodySize ?? 0);
      responses += 1;
      lastAt = resource.responseEnd || resource.startTime;
      changed = true;
    }
    if (changed) onProgress?.({ bytes, responses, lastAt });
  });
  try {
    observer.observe({ type: "resource", buffered: true });
  } catch {
    return { snapshot: () => EMPTY, dispose: () => undefined };
  }
  return {
    snapshot: () => ({ bytes, responses, lastAt }),
    dispose: () => observer.disconnect(),
  };
}

/** `2m 05s`, `45s` — for a "still working after …" line that reads like a wait. */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

