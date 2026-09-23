"use client";

import { memo, useMemo, type CSSProperties } from "react";
import * as stylex from "@stylexjs/stylex";
import { motionRecipe } from "../stylex/recipes.stylex";
import { mergeStyleProps } from "../components/stylex/surface";
import { ROADS_CELL, type PlannedDownloadCell } from "../lib/maps/frontend/map-download-plan";
import { styles } from "./MapDownloadCity.stylex";

/**
 * A map's download drawn as the city it is: the map's real tile grid in
 * isometric, one lot per published tile, each block as tall as its geometry
 * is dense. Lots are outlines until their files are resident; then the block
 * rises. The road layer lights the street grid first. Nothing here is
 * decorative guesswork: a lit block is a tile whose models and textures are
 * in the cache.
 *
 * Pure SVG driven by props; the parent re-renders it at the download store's
 * notify rate (~8 Hz), and each block is memoised so only the lots that
 * changed are touched.
 */

/** Half-width and half-height of one lot's diamond, in SVG units (2:1 isometric). */
const HALF_W = 1;
const HALF_H = 0.5;
/** A block stands on 78% of its lot, leaving the street around it. */
const FOOTPRINT = 0.78;
const MIN_BLOCK = 0.18;
const MAX_BLOCK = 1.5;

type Point = readonly [number, number];

function diamond(cx: number, cy: number, scale: number, lift = 0): Point[] {
  return [
    [cx, cy - HALF_H * scale - lift],
    [cx + HALF_W * scale, cy - lift],
    [cx, cy + HALF_H * scale - lift],
    [cx - HALF_W * scale, cy - lift],
  ];
}

function points(list: readonly Point[]): string {
  return list.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" ");
}

function project(gridX: number, gridZ: number): Point {
  return [(gridX - gridZ) * HALF_W, (gridX + gridZ) * HALF_H];
}

export type MapDownloadCityProps = {
  columns: number;
  rows: number;
  cells: readonly PlannedDownloadCell[];
  lit: ReadonlySet<string>;
  activeCell?: string | null;
  /** Accessible summary; the drawing itself is decorative. */
  label: string;
  testId?: string;
};

export function MapDownloadCity({ columns, rows, cells, lit, activeCell = null, label, testId }: MapDownloadCityProps) {
  const layout = useMemo(() => {
    const maxLog = Math.max(1, ...cells.map((cell) => Math.log10(1 + cell.triangles)));
    const blocks = [...cells]
      // Painter's order: back to front.
      .sort((a, b) => (a.gridX + a.gridZ) - (b.gridX + b.gridZ) || a.gridX - b.gridX)
      .map((cell) => ({
        cell,
        height: MIN_BLOCK + (MAX_BLOCK - MIN_BLOCK) * (Math.log10(1 + cell.triangles) / maxLog),
      }));
    const minX = -rows * HALF_W - HALF_W;
    const maxX = columns * HALF_W + HALF_W;
    const minY = -HALF_H - MAX_BLOCK;
    const maxY = (columns + rows) * HALF_H + HALF_H;
    // The street grid: every lot boundary of the map's full grid.
    const lines: string[] = [];
    for (let z = 0; z <= rows; z += 1) {
      const [ax, ay] = project(-0.5, z - 0.5);
      const [bx, by] = project(columns - 0.5, z - 0.5);
      lines.push(`M${ax.toFixed(3)} ${ay.toFixed(3)}L${bx.toFixed(3)} ${by.toFixed(3)}`);
    }
    for (let x = 0; x <= columns; x += 1) {
      const [ax, ay] = project(x - 0.5, -0.5);
      const [bx, by] = project(x - 0.5, rows - 0.5);
      lines.push(`M${ax.toFixed(3)} ${ay.toFixed(3)}L${bx.toFixed(3)} ${by.toFixed(3)}`);
    }
    return { blocks, viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`, streets: lines.join("") };
  }, [cells, columns, rows]);

  return (
    <svg
      {...stylex.props(styles.svg)}
      viewBox={layout.viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
      data-testid={testId}
      data-lit-cells={lit.size}
      data-total-cells={cells.length}
    >
      <path d={layout.streets} {...stylex.props(styles.streets, lit.has(ROADS_CELL) && styles.streetsLit)} />
      {layout.blocks.map(({ cell, height }) => (
        <Block key={cell.id} cell={cell} height={height} lit={lit.has(cell.id)} active={activeCell === cell.id} />
      ))}
    </svg>
  );
}

const Block = memo(function Block({ cell, height, lit, active }: {
  cell: PlannedDownloadCell;
  height: number;
  lit: boolean;
  active: boolean;
}) {
  const [cx, cy] = project(cell.gridX, cell.gridZ);
  const base = diamond(cx, cy, FOOTPRINT);
  const roof = diamond(cx, cy, FOOTPRINT, height);
  const [, right, bottom, left] = base;
  const [, roofRight, roofBottom, roofLeft] = roof;
  return (
    <g data-cell={cell.id} data-lit={lit ? "true" : "false"}>
      <polygon
        points={points(base)}
        {...stylex.props(styles.lot, lit && styles.lotLit, active && [styles.lotActive, motionRecipe.pulse])}
      />
      <g {...mergeStyleProps(stylex.props(styles.building, lit && styles.buildingLit), undefined, { "--rise": height } as CSSProperties)}>
        <polygon points={points([left!, bottom!, roofBottom!, roofLeft!])} {...stylex.props(styles.wallLeft)} />
        <polygon points={points([bottom!, right!, roofRight!, roofBottom!])} {...stylex.props(styles.wallRight)} />
        <polygon points={points(roof)} {...stylex.props(styles.roof)} />
        {cell.hasVegetation ? (
          <circle cx={cx + HALF_W * 0.55} cy={cy - HALF_H * 0.1} r={0.16} {...stylex.props(styles.canopy)} />
        ) : null}
      </g>
    </g>
  );
});
