"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";

/** One lane centreline in scene metres, as the lane index stores it. */
export interface MinimapLane {
  readonly xs: Float64Array | readonly number[];
  readonly zs: Float64Array | readonly number[];
}

export interface MinimapHandle {
  /** Redraw centred on the car. Called from the render loop, so it must not allocate. */
  draw(x: number, z: number, headingRad: number): void;
}

/** Metres from the car to the edge of the minimap disc. */
const VIEW_RADIUS_M = 160;
const LANE_COLOR = "rgba(255,255,255,0.34)";
const EGO_COLOR = "#E8E044";

/**
 * Lane-graph minimap.
 *
 * The whole network is baked into one `Path2D` in world coordinates when the
 * lanes arrive; every frame then costs one canvas transform and one stroke,
 * rather than re-walking 12 000 vertices. Rotating the path instead of the
 * points is also what keeps the map heading-up without any per-frame maths.
 */
export const Minimap = forwardRef<MinimapHandle, {
  lanes: readonly MinimapLane[];
  /** Device-independent size in CSS pixels; the canvas backs it at device ratio. */
  sizePx?: number;
}>(function Minimap({ lanes, sizePx = 168 }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const path = useMemo(() => {
    const built = new Path2D();
    for (const lane of lanes) {
      const { xs, zs } = lane;
      if (xs.length < 2) continue;
      built.moveTo(xs[0]!, zs[0]!);
      for (let index = 1; index < xs.length; index += 1) built.lineTo(xs[index]!, zs[index]!);
    }
    return built;
  }, [lanes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(sizePx * ratio);
    canvas.height = Math.round(sizePx * ratio);
    contextRef.current = canvas.getContext("2d");
    return () => {
      contextRef.current = null;
    };
  }, [sizePx]);

  useImperativeHandle(ref, () => ({
    draw(x, z, headingRad) {
      const context = contextRef.current;
      if (!context) return;
      const size = context.canvas.width;
      const half = size / 2;
      const scale = half / VIEW_RADIUS_M;
      context.clearRect(0, 0, size, size);
      context.save();
      context.translate(half, half);
      // Scene (x, z) is already a correct top-down view on a canvas: +X right,
      // +Z south and down-screen. Heading runs CCW about +Y from +X, so
      // rotating the whole path by (heading - 90°) puts the car's forward
      // direction at the top of the disc with left-of-travel on the left.
      context.rotate(headingRad - Math.PI / 2);
      context.scale(scale, scale);
      context.translate(-x, -z);
      context.lineWidth = 3 / scale;
      context.strokeStyle = LANE_COLOR;
      context.stroke(path);
      context.restore();

      context.fillStyle = EGO_COLOR;
      context.beginPath();
      context.moveTo(half, half - 7);
      context.lineTo(half - 5, half + 6);
      context.lineTo(half + 5, half + 6);
      context.closePath();
      context.fill();
    },
  }), [path]);

  return (
    <canvas
      aria-hidden="true"
      className="rounded-full border border-white/15 bg-black/55 backdrop-blur"
      data-testid="drive-minimap"
      ref={canvasRef}
      style={{ width: sizePx, height: sizePx }}
    />
  );
});
