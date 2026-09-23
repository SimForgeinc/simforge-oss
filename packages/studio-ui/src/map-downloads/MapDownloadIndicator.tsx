"use client";

import { useEffect, type CSSProperties } from "react";
import * as stylex from "@stylexjs/stylex";
import { getMapDownloadManager, useMapDownloads } from "../lib/maps/frontend/map-downloads";
import { styles } from "./MapDownloadIndicator.stylex";
import { mergeStyleProps } from "../components/stylex/surface";

/** Circumference of the ring's path when `pathLength` is 100. */
const RING = 100;

/**
 * A small progress ring for a map download that is running (or paused, or
 * just failed) while the panel is closed. Renders nothing when there is no
 * job. The first one mounted in a page also restores a job a previous page
 * left behind, so a reload resumes the download without anyone opening the
 * panel.
 */
export function MapDownloadIndicator({ inline = false, restore = false }: {
  /** In a row of text instead of pinned to a corner. */
  inline?: boolean;
  /** Resume a job stored by a previous page. Mount exactly one with this. */
  restore?: boolean;
}) {
  const job = useMapDownloads();
  useEffect(() => {
    if (restore) void getMapDownloadManager().restore();
  }, [restore]);
  if (!job || job.status === "idle" || job.status === "cancelled" || job.status === "complete") return null;
  const fraction = job.totalBytes > 0 ? Math.min(1, job.doneBytes / job.totalBytes) : 0;
  const percent = Math.floor(fraction * 100);
  const label = job.status === "paused"
    ? `Map download paused at ${percent}%`
    : job.status === "failed"
      ? "Map download stopped with an error"
      : `Downloading maps: ${percent}%`;
  return (
    <span
      {...mergeStyleProps(stylex.props(styles.root, inline && styles.inline), undefined, { "--ring-progress": fraction } as CSSProperties)}
      role="img"
      aria-label={label}
      title={label}
      data-testid="map-download-indicator"
      data-status={job.status}
      data-percent={percent}
    >
      <svg viewBox="0 0 20 20" {...stylex.props(styles.svg)} aria-hidden="true">
        <circle cx={10} cy={10} r={9} {...stylex.props(styles.disc)} />
        <circle cx={10} cy={10} r={7} pathLength={RING} {...stylex.props(styles.track)} />
        <circle
          cx={10}
          cy={10}
          r={7}
          pathLength={RING}
          {...stylex.props(styles.arc, job.status === "paused" && styles.arcPaused, job.status === "failed" && styles.arcFailed)}
        />
      </svg>
    </span>
  );
}
