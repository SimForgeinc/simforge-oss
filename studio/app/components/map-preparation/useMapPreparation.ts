"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { readMapInstall, startMapInstall, followMapInstall } from "@/app/lib/host/map-install";

/**
 * The sequential map preparation loop, shared by first-run onboarding and
 * Settings > Render Settings.
 *
 * Installs run one map at a time on purpose: the host downloads a closure with
 * its own member concurrency, so overlapping maps would only trade a readable
 * "map 2 of 7" for contention. A failed map stops the loop and waits — the
 * user decides between Retry and Skip — because a wall of failed rows is worse
 * than one actionable one.
 *
 * The installs themselves are host jobs that outlive this component: closing
 * the window mid-download leaves them running, and a later mount joins them
 * (see the resume probe below) instead of restarting anything.
 */

/** The profile onboarding and Settings both install: it also fills the browser closure. */
const PREPARATION_PROFILE = "semantic";

const CatalogSchema = z.object({
  maps: z.array(
    z.object({
      mapVersionId: z.string().min(1),
      label: z.string().min(1),
      closureBytes: z.object({ browser: z.number(), semantic: z.number() }).nullable(),
    }),
  ),
});

export type MapPreparationState = "pending" | "installing" | "ready" | "error" | "skipped";

export type MapPreparationRow = {
  mapVersionId: string;
  label: string;
  state: MapPreparationState;
  completedBytes: number;
  /** Expected total, from the catalog plan until the install reports its own. */
  bytes: number;
  message: string | null;
};

/**
 * `idle` before the first start, `blocked` while a failed map waits for Retry
 * or Skip, `complete` when every map is ready or skipped.
 */
export type MapPreparationPhase = "idle" | "installing" | "blocked" | "complete";

export type MapPreparation = {
  phase: MapPreparationPhase;
  maps: MapPreparationRow[];
  start: () => void;
  retry: (mapVersionId: string) => void;
  skip: (mapVersionId: string) => void;
};

export function useMapPreparation({ mapVersionIds }: { mapVersionIds: readonly string[] }): MapPreparation {
  const [phase, setPhase] = useState<MapPreparationPhase>("idle");
  const [maps, setMaps] = useState<MapPreparationRow[]>([]);
  const rows = useRef<MapPreparationRow[]>([]);
  const runner = useRef<AbortController | null>(null);
  /**
   * Ids the loop may install. A row can be `pending` without being queued:
   * after a relaunch only the maps the host is actually still downloading are
   * joined, so resuming never starts downloads the user did not ask for.
   */
  const queue = useRef<Set<string>>(new Set());
  const key = mapVersionIds.join("\u0000");

  const commit = useCallback((next: MapPreparationRow[]) => {
    rows.current = next;
    setMaps(next);
  }, []);

  const patch = useCallback(
    (mapVersionId: string, change: Partial<MapPreparationRow>) => {
      commit(rows.current.map((row) => (row.mapVersionId === mapVersionId ? { ...row, ...change } : row)));
    },
    [commit],
  );

  const run = useCallback(() => {
    if (runner.current) return;
    const controller = new AbortController();
    runner.current = controller;
    setPhase("installing");
    void (async () => {
      try {
        for (;;) {
          const next = rows.current.find((row) => row.state === "pending" && queue.current.has(row.mapVersionId));
          if (!next) break;
          const { mapVersionId, label } = next;
          patch(mapVersionId, { state: "installing", message: null });
          try {
            const result = await followMapInstall(
              mapVersionId,
              PREPARATION_PROFILE,
              startMapInstall(mapVersionId, PREPARATION_PROFILE, controller.signal),
              controller.signal,
              (state) => {
                if (!state.progress) return;
                patch(mapVersionId, {
                  completedBytes: state.progress.completedBytes,
                  bytes: state.progress.bytes,
                });
              },
            );
            if (result.state !== "ready") throw new Error(result.message ?? `${label} could not be installed.`);
            patch(mapVersionId, { state: "ready", message: null });
          } catch (reason) {
            if (controller.signal.aborted) return;
            patch(mapVersionId, {
              state: "error",
              message: reason instanceof Error ? reason.message : `${label} could not be installed.`,
            });
            setPhase("blocked");
            return;
          }
        }
        if (!controller.signal.aborted) setPhase("complete");
      } finally {
        if (runner.current === controller) runner.current = null;
      }
    })();
  }, [patch]);

  // Rebuild the rows when the selection changes, keeping the progress of maps
  // that stay selected so toggling a checkbox never restarts a download.
  useEffect(() => {
    const ids = key === "" ? [] : key.split("\u0000");
    commit(
      ids.map(
        (mapVersionId) =>
          rows.current.find((row) => row.mapVersionId === mapVersionId) ?? {
            mapVersionId,
            label: mapVersionId,
            state: "pending" as const,
            completedBytes: 0,
            bytes: 0,
            message: null,
          },
      ),
    );
  }, [key, commit]);

  // Real labels and expected sizes, so a row reads "Easterbrook · 0 / 412 MB"
  // before its install has reported anything.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch("/api/simforge/maps/catalog", { cache: "no-store", signal: controller.signal });
      if (!response.ok) return;
      const catalog = CatalogSchema.parse(await response.json());
      if (controller.signal.aborted) return;
      commit(
        rows.current.map((row) => {
          const map = catalog.maps.find((candidate) => candidate.mapVersionId === row.mapVersionId);
          if (!map) return row;
          return {
            ...row,
            label: map.label,
            // The install reports the bytes of both closures it transfers
            // (`semantic` includes the browser one), so the estimate that
            // stands in for it until the first progress event says the same.
            bytes: row.bytes > 0
              ? row.bytes
              : (map.closureBytes ? map.closureBytes.browser + map.closureBytes.semantic : 0),
          };
        }),
      );
    })().catch(() => {
      // Labels are cosmetic; an unreachable catalog leaves the ids showing.
    });
    return () => controller.abort();
  }, [key, commit]);

  // Resume probe: a host install still running from a previous window (or an
  // earlier mount of this page) is joined and shown live rather than ignored.
  useEffect(() => {
    if (phase !== "idle") return;
    const ids = key === "" ? [] : key.split("\u0000");
    if (ids.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      const states = await Promise.all(
        ids.map((mapVersionId) =>
          readMapInstall(mapVersionId, PREPARATION_PROFILE, controller.signal).catch(() => null),
        ),
      );
      if (controller.signal.aborted) return;
      const running = ids.filter((_, index) => states[index]?.state === "materializing");
      if (running.length === 0) return;
      queue.current = new Set(running);
      run();
    })();
    return () => controller.abort();
  }, [key, phase, run]);

  useEffect(() => () => runner.current?.abort(), []);

  const start = useCallback(() => {
    queue.current = new Set(rows.current.map((row) => row.mapVersionId));
    commit(
      rows.current.map((row) => (row.state === "ready" ? row : { ...row, state: "pending", message: null })),
    );
    run();
  }, [commit, run]);

  const retry = useCallback(
    (mapVersionId: string) => {
      queue.current.add(mapVersionId);
      patch(mapVersionId, { state: "pending", message: null, completedBytes: 0 });
      run();
    },
    [patch, run],
  );

  const skip = useCallback(
    (mapVersionId: string) => {
      queue.current.delete(mapVersionId);
      patch(mapVersionId, { state: "skipped", message: null });
      run();
    },
    [patch, run],
  );

  return { phase, maps, start, retry, skip };
}
