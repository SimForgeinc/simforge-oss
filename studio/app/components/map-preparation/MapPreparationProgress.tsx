"use client";

import { Check, CircleAlert, LoaderCircle, RotateCcw, SkipForward } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import type { MapPreparationPhase, MapPreparationRow } from "./useMapPreparation";

/**
 * One row per map being prepared, with the two actions a failed row offers.
 * Presentational: every decision (what is queued, what failed, what happens
 * next) belongs to {@link useMapPreparation}.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const STATE_LABELS: Record<MapPreparationRow["state"], string> = {
  pending: "Waiting",
  installing: "Downloading",
  ready: "Ready",
  error: "Failed",
  skipped: "Skipped",
};

export function MapPreparationProgress({
  phase,
  maps,
  onRetry,
  onSkip,
}: {
  phase: MapPreparationPhase;
  maps: readonly MapPreparationRow[];
  onRetry: (mapVersionId: string) => void;
  onSkip: (mapVersionId: string) => void;
}) {
  const ready = maps.filter((map) => map.state === "ready" || map.state === "skipped").length;
  return (
    <div data-testid="map-preparation-progress" data-phase={phase}>
      <div className="flex items-baseline justify-between font-mono text-micro uppercase text-white/35">
        <span>
          {ready} / {maps.length} maps
        </span>
        <span>{phase === "complete" ? "Done" : phase === "blocked" ? "Needs attention" : "Downloading"}</span>
      </div>
      <ul className="mt-3 grid gap-2">
        {maps.map((map) => {
          const percent = map.bytes > 0 ? Math.min(100, Math.round((100 * map.completedBytes) / map.bytes)) : 0;
          return (
            <li
              key={map.mapVersionId}
              className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5"
              data-testid="map-preparation-row"
              data-map-version-id={map.mapVersionId}
              data-state={map.state}
            >
              <div className="flex items-center gap-3">
                <span className="grid size-5 shrink-0 place-items-center text-[#E8E044]">
                  {map.state === "ready" ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : map.state === "installing" ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : map.state === "error" ? (
                    <CircleAlert className="size-4 text-destructive" aria-hidden="true" />
                  ) : map.state === "skipped" ? (
                    <SkipForward className="size-4 text-white/35" aria-hidden="true" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-white/80">{map.label}</span>
                <span className="font-mono text-[11px] text-white/40">
                  {map.state === "installing" || map.state === "ready"
                    ? `${formatBytes(map.completedBytes)}${map.bytes > 0 ? ` / ${formatBytes(map.bytes)}` : ""}`
                    : STATE_LABELS[map.state]}
                </span>
                {map.state === "error" ? (
                  <span className="flex shrink-0 gap-2">
                    <Button variant="outline" onClick={() => onRetry(map.mapVersionId)}>
                      <RotateCcw className="mr-1 size-3.5" aria-hidden="true" />
                      Retry
                    </Button>
                    <Button variant="outline" onClick={() => onSkip(map.mapVersionId)}>
                      Skip
                    </Button>
                  </span>
                ) : null}
              </div>
              {map.state === "installing" ? (
                <div
                  className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"
                  role="progressbar"
                  aria-label={`${map.label} download`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <div className="h-full rounded-full bg-[#E8E044] transition-[width] duration-500" style={{ width: `${percent}%` }} />
                </div>
              ) : null}
              {map.message ? (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {map.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
