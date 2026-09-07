"use client";

/**
 * Bird's-eye plot of metric trajectories in the ego frame.
 *
 * This is the honest default view. Trajectories arrive as metres in a named
 * frame (FLU: x forward, y left, z up), so the plot is a direct rendering of
 * the numbers with a scale bar — no camera calibration is involved and nothing
 * is claimed about where the path falls in the image.
 */

import { cn } from "../../lib/utils";
import type { OpenLoopItem } from "../contracts";

const WIDTH = 320;
const HEIGHT = 420;
const PADDING = 24;

type Extent = { minX: number; maxX: number; minY: number; maxY: number };

function extentOf(polylines: number[][][]): Extent {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const line of polylines) {
    for (const point of line) {
      if (point.length < 2) continue;
      minX = Math.min(minX, point[0]);
      maxX = Math.max(maxX, point[0]);
      minY = Math.min(minY, point[1]);
      maxY = Math.max(maxY, point[1]);
    }
  }
  // Keep the ego at the bottom centre with a readable minimum window.
  return {
    minX: Math.min(minX, -2),
    maxX: Math.max(maxX, 10),
    minY: Math.min(minY, -6),
    maxY: Math.max(maxY, 6),
  };
}

export function TrajectoryPlot({
  item,
  className,
}: {
  item: OpenLoopItem;
  className?: string;
}) {
  const samples = item.points;
  const reference = item.reference.points.length > 0 ? item.reference.points : null;
  const polylines = reference ? [...samples, reference] : samples;

  if (polylines.length === 0) {
    return (
      <div
        className={cn(
          "flex h-64 items-center justify-center border border-border bg-muted/20 px-6 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        This item produced no trajectory to plot.
      </div>
    );
  }

  const extent = extentOf(polylines);
  const spanForward = extent.maxX - extent.minX;
  const spanLateral = extent.maxY - extent.minY;
  const scale = Math.min(
    (HEIGHT - PADDING * 2) / (spanForward || 1),
    (WIDTH - PADDING * 2) / (spanLateral || 1),
  );

  // Forward (+x) is up; left (+y) is left, so lateral is negated in screen x.
  const project = (point: number[]) => ({
    x: WIDTH / 2 - point[1] * scale,
    y: HEIGHT - PADDING - (point[0] - extent.minX) * scale,
  });

  const pathOf = (line: number[][]) =>
    line
      .filter((point) => point.length >= 2)
      .map((point, index) => {
        const { x, y } = project(point);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");

  const gridStepM = spanForward > 60 ? 20 : spanForward > 25 ? 10 : 5;
  const gridLines: number[] = [];
  for (let metres = Math.ceil(extent.minX / gridStepM) * gridStepM; metres <= extent.maxX; metres += gridStepM) {
    gridLines.push(metres);
  }

  return (
    <figure className={cn("min-w-0", className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Bird's-eye trajectory plot for item ${item.itemId}, ${item.convention ?? "FLU"} frame, metres`}
        className="h-auto w-full bg-muted/10"
        data-testid="trajectory-plot"
      >
        {gridLines.map((metres) => {
          const y = HEIGHT - PADDING - (metres - extent.minX) * scale;
          return (
            <g key={metres}>
              <line
                x1={PADDING / 2}
                x2={WIDTH - PADDING / 2}
                y1={y}
                y2={y}
                className="stroke-border"
                strokeWidth={0.5}
              />
              <text x={4} y={y - 3} className="fill-muted-foreground" fontSize={9}>
                {metres} m
              </text>
            </g>
          );
        })}
        <line
          x1={WIDTH / 2}
          x2={WIDTH / 2}
          y1={PADDING / 2}
          y2={HEIGHT - PADDING / 2}
          className="stroke-border"
          strokeWidth={0.5}
          strokeDasharray="3 4"
        />

        {samples.map((line, index) => (
          <path
            key={`sample-${index}`}
            d={pathOf(line)}
            fill="none"
            className="stroke-primary"
            strokeWidth={samples.length > 1 ? 1.25 : 2}
            strokeOpacity={samples.length > 1 ? 0.55 : 0.9}
          />
        ))}
        {reference ? (
          <path
            d={pathOf(reference)}
            fill="none"
            className="stroke-foreground"
            strokeWidth={2}
            strokeDasharray="6 4"
          />
        ) : null}

        <circle cx={WIDTH / 2} cy={HEIGHT - PADDING - (0 - extent.minX) * scale} r={4} className="fill-foreground" />
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-5 bg-primary" />
          {samples.length > 1 ? `${samples.length} predicted samples` : "prediction"}
        </span>
        {reference ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-5 bg-foreground"
              style={{ backgroundImage: "repeating-linear-gradient(90deg,currentColor 0 6px,transparent 6px 10px)" }}
            />
            reference ({item.reference.kind})
          </span>
        ) : (
          <span>no reference future — prediction only, not scored</span>
        )}
        <span>
          {item.convention ?? "FLU"} · {item.dtS ? `${item.dtS}s step` : "step unspecified"}
          {item.horizonS ? ` · ${item.horizonS}s horizon` : ""}
        </span>
      </figcaption>
    </figure>
  );
}
