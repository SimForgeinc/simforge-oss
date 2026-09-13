"use client";

/**
 * Per-frame image-space overlay: the source clip with predicted and reference
 * paths drawn on it.
 *
 * Rendered only when the clip carried camera calibration. Without it this
 * component is not used at all — see `createProjector`, which returns null
 * rather than guessing, and the result screen falls back to the metric
 * bird's-eye plot.
 */

import { useMemo, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";
import { styles as s } from "./evaluation-components.stylex";
import type { OpenLoopItem, TrajectoryProjection } from "../contracts";
import { createProjector, projectPolyline } from "../projection";

export type FrameSource =
  | { kind: "video"; url: string }
  | { kind: "frames"; urls: string[]; timestampsUs: number[] };

export function FrameOverlay({
  item,
  projection,
  source,
  className,
}: {
  item: OpenLoopItem;
  projection: TrajectoryProjection;
  source: FrameSource;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [width, height] = projection.imageSize;

  const projector = useMemo(() => createProjector(projection), [projection]);
  const paths = useMemo(() => {
    if (!projector) return { samples: [] as string[], reference: null as string | null };
    const toPath = (line: number[][]) => {
      const points = projectPolyline(projector, line);
      if (points.length < 2) return null;
      return points
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
        .join(" ");
    };
    const samples = item.points
      .map(toPath)
      .filter((path): path is string => path !== null);
    const referencePoints = item.reference.points.length > 0 ? item.reference.points : null;
    return { samples, reference: referencePoints ? toPath(referencePoints) : null };
  }, [projector, item]);

  if (!projector) return null;

  const frameCount = source.kind === "frames" ? source.urls.length : 0;
  const step = (delta: number) => {
    if (source.kind === "frames") {
      setFrameIndex((current) => Math.min(frameCount - 1, Math.max(0, current + delta)));
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    const dt = item.dtS ?? 0.1;
    video.currentTime = Math.max(0, video.currentTime + delta * dt);
  };

  return (
    <figure className={cn(stylex.props(s.figure).className, className)}>
      <div {...stylex.props(s.relative, s.black)} style={{ aspectRatio: `${width} / ${height}` }}>
        {source.kind === "video" ? (
          <video
            ref={videoRef}
            src={source.url}
            controls
            playsInline
            preload="metadata"
            {...stylex.props(s.full, s.objectContain)}
            data-testid="overlay-video"
          />
        ) : (
          <img
            src={source.urls[Math.min(frameIndex, frameCount - 1)]}
            alt={`Camera ${projection.cameraId} frame ${frameIndex + 1} of ${frameCount}`}
            {...stylex.props(s.full, s.objectContain)}
            data-testid="overlay-frame"
          />
        )}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          {...stylex.props(s.absoluteOverlay)}
          data-testid="overlay-svg"
        >
          {paths.samples.map((path, index) => (
            <path
              key={index}
              d={path}
              fill="none"
              {...stylex.props(s.strokePrimary)}
              strokeWidth={Math.max(2, width / 320)}
              strokeOpacity={paths.samples.length > 1 ? 0.6 : 0.95}
            />
          ))}
          {paths.reference ? (
            <path
              d={paths.reference}
              fill="none"
              stroke="#ffffff"
              strokeWidth={Math.max(2, width / 320)}
              strokeDasharray={`${Math.max(8, width / 80)} ${Math.max(6, width / 110)}`}
            />
          ) : null}
        </svg>
      </div>

      <div {...stylex.props(s.mt2, s.flexCenterBetween)}>
        <figcaption {...stylex.props(s.textXs, s.textMuted)}>
          Camera {projection.cameraId} · {width}×{height} · projected from{" "}
          {item.convention ?? "FLU"} metres using the clip&apos;s own calibration
          {projection.distortion ? ` (${projection.distortion.model} distortion)` : ""}
        </figcaption>
        <div {...stylex.props(s.rowTight)}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => step(-1)}
            aria-label="Previous frame"
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          {source.kind === "frames" ? (
            <span {...stylex.props(s.tabular, s.textXs, s.textMuted)} style={{ minWidth: "5rem", textAlign: "center" }}>
              {frameIndex + 1} / {frameCount}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => step(1)}
            aria-label="Next frame"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </figure>
  );
}
