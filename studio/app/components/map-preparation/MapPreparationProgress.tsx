"use client";

import type { CSSProperties } from "react";
import { Check, CircleAlert, LoaderCircle, RotateCcw, SkipForward } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { setup } from "../setup-preparation.stylex";
import { PROGRESS_VAR, preparation } from "./map-preparation.stylex";
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
      <div {...stylex.props(preparation.summary)}>
        <span>
          {ready} / {maps.length} maps
        </span>
        <span>{phase === "complete" ? "Done" : phase === "blocked" ? "Needs attention" : "Downloading"}</span>
      </div>
      <ul {...stylex.props(preparation.list)}>
        {maps.map((map) => {
          const percent = map.bytes > 0 ? Math.min(100, Math.round((100 * map.completedBytes) / map.bytes)) : 0;
          return (
            <li
              key={map.mapVersionId}
              {...stylex.props(preparation.row)}
              data-testid="map-preparation-row"
              data-map-version-id={map.mapVersionId}
              data-state={map.state}
            >
              <div {...stylex.props(preparation.rowHead)}>
                <span {...stylex.props(preparation.stateIcon)}>
                  {map.state === "ready" ? (
                    <Check {...stylex.props(setup.iconSmall)} aria-hidden="true" />
                  ) : map.state === "installing" ? (
                    <LoaderCircle {...stylex.props(setup.iconSmall, setup.spinIcon)} aria-hidden="true" />
                  ) : map.state === "error" ? (
                    <CircleAlert {...stylex.props(setup.iconSmall)} aria-hidden="true" />
                  ) : map.state === "skipped" ? (
                    <SkipForward {...stylex.props(setup.iconSmall)} aria-hidden="true" />
                  ) : null}
                </span>
                <span {...stylex.props(preparation.rowLabel)}>{map.label}</span>
                <span {...stylex.props(preparation.rowBytes)}>
                  {map.state === "installing" || map.state === "ready"
                    ? `${formatBytes(map.completedBytes)}${map.bytes > 0 ? ` / ${formatBytes(map.bytes)}` : ""}`
                    : STATE_LABELS[map.state]}
                </span>
                {map.state === "error" ? (
                  <span {...stylex.props(preparation.rowActions)}>
                    <Button variant="outline" onClick={() => onRetry(map.mapVersionId)}>
                      <RotateCcw {...stylex.props(setup.iconSmall)} aria-hidden="true" />
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
                  {...stylex.props(preparation.track)}
                  role="progressbar"
                  aria-label={`${map.label} download`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <div
                    {...stylex.props(preparation.fill)}
                    style={{ [PROGRESS_VAR]: `${percent}%` } as CSSProperties}
                  />
                </div>
              ) : null}
              {map.message ? (
                <p {...stylex.props(preparation.rowMessage)} role="alert">
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
