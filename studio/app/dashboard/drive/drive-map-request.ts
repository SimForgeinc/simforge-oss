"use client";

import { useEffect } from "react";

/**
 * Which map Drive must open without an explicit choice: the editor take's
 * map wins over a `?map=` deep link. Both inputs arrive asynchronously on the
 * client (the take session from storage after hydration, the URL after the
 * server render), so the caller re-evaluates this whenever either changes.
 */
export function requestedDriveMapId(takeMapVersionId: string | null, urlMapVersionId: string | null): string | null {
  return takeMapVersionId ?? urlMapVersionId;
}

/**
 * Open the requested map whenever it is named and not already active. Keyed
 * by the requested id, so a take that resolves after the first render still
 * opens, and a change of id aborts the open that is no longer wanted.
 */
export function useRequestedMapOpen({ requestedMapId, activeMapVersionId, suspended, open }: {
  requestedMapId: string | null;
  activeMapVersionId: string | null;
  /** True while another map source (a direct bundle) owns the surface. */
  suspended: boolean;
  open: (mapVersionId: string, signal: AbortSignal) => Promise<void>;
}): void {
  useEffect(() => {
    if (!requestedMapId || suspended || activeMapVersionId === requestedMapId) return;
    const controller = new AbortController();
    void open(requestedMapId, controller.signal);
    return () => controller.abort();
  }, [activeMapVersionId, open, requestedMapId, suspended]);
}
