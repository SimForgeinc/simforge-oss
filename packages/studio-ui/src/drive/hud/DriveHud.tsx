"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import type { DriveCameraKind } from "../cameras";
import type { DriveTelemetry } from "../telemetry";
import { Minimap, type MinimapHandle, type MinimapLane } from "./Minimap";

/** Everything the HUD shows that is not telemetry. */
export interface DriveHudFrame {
  /** Seconds since the session spawned. */
  elapsedS: number;
  cameraKind: DriveCameraKind;
  /** Car position and heading, for the minimap. */
  x: number;
  z: number;
  headingRad: number;
  /** Renderer frame time in ms, shown by the debug toggle. */
  frameMs: number;
}

export interface DriveHudHandle {
  /**
   * Push one frame into the HUD.
   *
   * Writes straight to DOM nodes: a React re-render per truth frame would cost
   * more than the rest of the game loop put together, and at 60 fps it shows.
   */
  update(telemetry: DriveTelemetry, frame: DriveHudFrame): void;
}

export type SpeedUnits = "kmh" | "mph";

/** Engine speed the tachometer arc spans, and where it turns red. */
const RPM_FULL_SCALE = 8000;
const RPM_REDLINE = 6600;
/** Arc geometry: a 240° sweep drawn as a stroked circle of radius 46 in a 120×120 box. */
const RPM_ARC_RADIUS = 46;
const RPM_ARC_SWEEP = (240 / 360) * 2 * Math.PI * RPM_ARC_RADIUS;
/** Impulse above which the HUD flashes. Kerb scrapes sit well below it. */
const COLLISION_FLASH_NS = 2000;
const COLLISION_FLASH_MS = 450;
const GEAR_LABELS: Readonly<Record<string, string>> = { "-1": "R", "0": "N" };

/**
 * The driving HUD: speed, tachometer and gear, minimap, g-meter, clock.
 *
 * Mounted once per session over the canvas. Per-frame values are written
 * imperatively through {@link DriveHudHandle}; React state here is only for the
 * things a human toggles, which change a handful of times per session.
 */
export const DriveHud = forwardRef<DriveHudHandle, {
  units: SpeedUnits;
  lanes: readonly MinimapLane[];
  debug: boolean;
  trafficEnabled: boolean;
  vehicleLabel: string;
  onToggleTraffic: () => void;
  onToggleUnits: () => void;
  onPause: () => void;
}>(function DriveHud(
  { units, lanes, debug, trafficEnabled, vehicleLabel, onToggleTraffic, onToggleUnits, onPause },
  ref,
) {
  const speedRef = useRef<HTMLSpanElement | null>(null);
  const gearRef = useRef<HTMLSpanElement | null>(null);
  const rpmArcRef = useRef<SVGCircleElement | null>(null);
  const rpmTextRef = useRef<HTMLSpanElement | null>(null);
  const gDotRef = useRef<HTMLDivElement | null>(null);
  const gReadoutRef = useRef<HTMLSpanElement | null>(null);
  const clockRef = useRef<HTMLSpanElement | null>(null);
  const cameraRef = useRef<HTMLSpanElement | null>(null);
  const surfaceRef = useRef<HTMLSpanElement | null>(null);
  const flashRef = useRef<HTMLDivElement | null>(null);
  const debugRef = useRef<HTMLSpanElement | null>(null);
  const minimapRef = useRef<MinimapHandle | null>(null);
  const unitsRef = useRef(units);
  const flashUntilRef = useRef(0);

  // The units toggle is ordinary React state and re-renders both labels; only
  // the per-frame number conversion needs the value inside the render loop.
  useEffect(() => {
    unitsRef.current = units;
  }, [units]);

  useImperativeHandle(ref, () => ({
    update(telemetry, frame) {
      const speed = Math.abs(telemetry.speedMps) * (unitsRef.current === "kmh" ? 3.6 : 2.236936);
      if (speedRef.current) speedRef.current.textContent = speed.toFixed(0);
      if (gearRef.current) {
        gearRef.current.textContent = GEAR_LABELS[String(telemetry.gear)] ?? String(telemetry.gear);
      }
      if (rpmArcRef.current) {
        const fraction = Math.max(0, Math.min(1, telemetry.rpm / RPM_FULL_SCALE));
        rpmArcRef.current.style.strokeDashoffset = String(RPM_ARC_SWEEP * (1 - fraction));
        rpmArcRef.current.style.stroke = telemetry.rpm >= RPM_REDLINE ? "#ff4d4d" : "#E8E044";
      }
      if (rpmTextRef.current) rpmTextRef.current.textContent = telemetry.rpm.toFixed(0);
      if (gDotRef.current) {
        // The dot sits in a ±1.5 g box, lateral on x and longitudinal on y with
        // acceleration pushing it down, which is the direction the driver feels.
        const lateral = Math.max(-1, Math.min(1, telemetry.lateralG / 1.5));
        const longitudinal = Math.max(-1, Math.min(1, telemetry.longitudinalG / 1.5));
        gDotRef.current.style.transform = `translate(${(lateral * 26).toFixed(1)}px, ${(longitudinal * 26).toFixed(1)}px)`;
      }
      if (gReadoutRef.current) {
        gReadoutRef.current.textContent = `${Math.hypot(telemetry.lateralG, telemetry.longitudinalG).toFixed(2)} g`;
      }
      if (clockRef.current) {
        const total = Math.max(0, Math.floor(frame.elapsedS));
        clockRef.current.textContent = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
      }
      if (cameraRef.current) cameraRef.current.textContent = frame.cameraKind;
      if (surfaceRef.current) {
        surfaceRef.current.textContent = telemetry.offRoad ? "OFF ROAD" : "";
      }
      if (flashRef.current) {
        const now = frame.elapsedS * 1000;
        if (telemetry.collisionImpulseNs > COLLISION_FLASH_NS) flashUntilRef.current = now + COLLISION_FLASH_MS;
        const remaining = flashUntilRef.current - now;
        flashRef.current.style.opacity = remaining > 0 ? (remaining / COLLISION_FLASH_MS * 0.55).toFixed(2) : "0";
      }
      if (debugRef.current) {
        debugRef.current.textContent = `${frame.frameMs.toFixed(1)} ms · ${(1000 / Math.max(0.01, frame.frameMs)).toFixed(0)} fps`;
      }
      minimapRef.current?.draw(frame.x, frame.z, frame.headingRad);
    },
  }), []);

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-body text-white" data-testid="drive-hud">
      <div
        className="absolute inset-0 bg-red-500 transition-opacity duration-100"
        data-testid="drive-impact-flash"
        ref={flashRef}
        style={{ opacity: 0 }}
      />

      <div className="absolute left-5 top-4 flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-white/55">
        <span className="text-white/80">{vehicleLabel}</span>
        <span className="tabular-nums" data-testid="drive-clock" ref={clockRef}>
          00:00
        </span>
        <span className="text-white/40" data-testid="drive-camera-kind" ref={cameraRef}>
          chase
        </span>
        <span className="font-semibold text-[#ff8a3d]" data-testid="drive-surface" ref={surfaceRef} />
      </div>

      <div className="pointer-events-auto absolute right-5 top-4 flex items-center gap-2">
        <button
          className={`rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.14em] transition-colors ${
            trafficEnabled ? "border-[#E8E044]/70 bg-[#E8E044]/15 text-[#E8E044]" : "border-white/15 bg-black/40 text-white/60 hover:border-white/30"
          }`}
          data-testid="drive-traffic-toggle"
          onClick={onToggleTraffic}
          type="button"
        >
          Traffic {trafficEnabled ? "on" : "off"}
        </button>
        <button
          className="rounded-full border border-white/15 bg-black/40 px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-white/60 transition-colors hover:border-white/30"
          data-testid="drive-units-toggle"
          onClick={onToggleUnits}
          type="button"
        >
          {units === "kmh" ? "km/h" : "mph"}
        </button>
        <button
          className="rounded-full border border-white/15 bg-black/40 px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-white/60 transition-colors hover:border-white/30"
          data-testid="drive-pause"
          onClick={onPause}
          type="button"
        >
          Esc
        </button>
      </div>

      {debug ? (
        <span
          className="absolute right-5 top-14 rounded-md border border-white/10 bg-black/55 px-2 py-1 font-mono text-[11px] tabular-nums text-white/70"
          data-testid="drive-debug"
          ref={debugRef}
        />
      ) : null}

      <div className="absolute bottom-5 left-5">
        <Minimap lanes={lanes} ref={minimapRef} />
      </div>

      <div className="absolute bottom-5 right-5 flex items-end gap-5">
        <div className="flex flex-col items-center gap-1" data-testid="drive-gmeter">
          <div className="relative size-[68px] rounded-full border border-white/15 bg-black/45">
            <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/10" />
            <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-white/10" />
            <div className="absolute left-1/2 top-1/2 -ml-[3px] -mt-[3px] size-[6px] rounded-full bg-[#E8E044]" ref={gDotRef} />
          </div>
          <span className="font-mono text-[10px] tabular-nums text-white/55" ref={gReadoutRef}>
            0.00 g
          </span>
        </div>

        <div className="relative grid size-[120px] place-items-center">
          <svg className="absolute inset-0 -rotate-[210deg]" viewBox="0 0 120 120">
            <circle
              cx="60"
              cy="60"
              fill="none"
              r={RPM_ARC_RADIUS}
              stroke="rgba(255,255,255,0.12)"
              strokeDasharray={`${RPM_ARC_SWEEP} ${2 * Math.PI * RPM_ARC_RADIUS}`}
              strokeLinecap="round"
              strokeWidth="7"
            />
            <circle
              cx="60"
              cy="60"
              data-testid="drive-rpm-arc"
              fill="none"
              r={RPM_ARC_RADIUS}
              ref={rpmArcRef}
              stroke="#E8E044"
              strokeDasharray={`${RPM_ARC_SWEEP} ${2 * Math.PI * RPM_ARC_RADIUS}`}
              strokeDashoffset={RPM_ARC_SWEEP}
              strokeLinecap="round"
              strokeWidth="7"
            />
          </svg>
          <div className="flex flex-col items-center">
            <span className="font-heavy text-4xl leading-none tabular-nums" data-testid="drive-speed" ref={speedRef}>
              0
            </span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-white/50">
              {units === "kmh" ? "km/h" : "mph"}
            </span>
          </div>
          <span
            className="absolute -bottom-1 right-1 font-heavy text-xl leading-none text-[#E8E044]"
            data-testid="drive-gear"
            ref={gearRef}
          >
            N
          </span>
          <span
            className="absolute -bottom-1 left-1 font-mono text-[10px] tabular-nums text-white/45"
            data-testid="drive-rpm"
            ref={rpmTextRef}
          >
            0
          </span>
        </div>
      </div>
    </div>
  );
});
