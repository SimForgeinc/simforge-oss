"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as stylex from "@stylexjs/stylex";

import type { DriveCameraKind } from "../cameras";
import { DrivePill, driveChrome } from "../chrome";
import { driveColors, driveRadius, driveText } from "../drive.stylex";
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
 * The instrument layout.
 *
 * Corners only: the HUD frames the world rather than sitting on it, so every
 * cluster is pinned to an edge and the middle of the screen stays the road.
 */
const styles = stylex.create({
  /**
   * A full-bleed impact flash. Its opacity is written per frame from the
   * collision impulse, so it carries no transition target of its own beyond
   * the fade Tailwind used to give it.
   */
  flash: {
    position: "absolute",
    inset: 0,
    backgroundColor: driveColors.impact,
    transitionProperty: "opacity",
    transitionDuration: "100ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },

  metaRow: {
    position: "absolute",
    left: "1.25rem",
    top: "1rem",
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  vehicle: { color: driveColors.textVehicle },
  camera: { color: driveColors.textFaint },
  /** Off the drivable surface — the one warning the HUD shows inline. */
  surface: {
    fontWeight: 600,
    color: driveColors.offRoad,
  },

  toggles: {
    position: "absolute",
    right: "1.25rem",
    top: "1rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  debug: {
    position: "absolute",
    right: "1.25rem",
    top: "3.5rem",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontFamily: driveText.fontMono,
    fontSize: driveText.sizeMeta,
    fontVariantNumeric: "tabular-nums",
    color: driveColors.textBody,
  },

  minimapSlot: {
    position: "absolute",
    bottom: "1.25rem",
    left: "1.25rem",
  },
  instruments: {
    position: "absolute",
    bottom: "1.25rem",
    right: "1.25rem",
    display: "flex",
    alignItems: "flex-end",
    gap: "1.25rem",
  },

  gMeter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.25rem",
  },
  dial: {
    position: "relative",
    width: "68px",
    height: "68px",
  },
  crosshairVertical: {
    position: "absolute",
    left: "50%",
    top: 0,
    height: "100%",
    width: "1px",
    transform: "translateX(-50%)",
    backgroundColor: driveColors.lineCrosshair,
  },
  crosshairHorizontal: {
    position: "absolute",
    left: 0,
    top: "50%",
    height: "1px",
    width: "100%",
    transform: "translateY(-50%)",
    backgroundColor: driveColors.lineCrosshair,
  },
  /** The g dot. Its own transform is written per frame. */
  gDot: {
    position: "absolute",
    left: "50%",
    top: "50%",
    marginLeft: "-3px",
    marginTop: "-3px",
    width: "6px",
    height: "6px",
    borderRadius: driveRadius.pill,
    backgroundColor: driveColors.accent,
  },
  gReadout: { color: driveColors.textMeta },

  tachometer: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    width: "120px",
    height: "120px",
  },
  arc: {
    position: "absolute",
    inset: 0,
    transform: "rotate(-210deg)",
  },
  speedStack: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  /** The one number read at speed: the heavy face, at 36px, undimmed. */
  speed: {
    fontFamily: driveText.fontHeavy,
    fontSize: "2.25rem",
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
  },
  speedUnits: {
    fontSize: driveText.sizeMicro,
    textTransform: "uppercase",
    letterSpacing: driveText.trackUnit,
    color: driveColors.textCaption,
  },
  gear: {
    position: "absolute",
    bottom: "-0.25rem",
    right: "0.25rem",
    fontFamily: driveText.fontHeavy,
    fontSize: "1.25rem",
    lineHeight: 1,
    color: driveColors.accent,
  },
  rpm: {
    position: "absolute",
    bottom: "-0.25rem",
    left: "0.25rem",
    color: driveColors.textDim,
  },
});

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
    <div {...stylex.props(driveChrome.worldOverlay)} data-testid="drive-hud">
      <div
        {...stylex.props(styles.flash)}
        data-testid="drive-impact-flash"
        ref={flashRef}
        style={{ opacity: 0 }}
      />

      <div {...stylex.props(driveChrome.metaRow, styles.metaRow)}>
        <span {...stylex.props(styles.vehicle)}>{vehicleLabel}</span>
        <span {...stylex.props(driveChrome.numeric)} data-testid="drive-clock" ref={clockRef}>
          00:00
        </span>
        <span {...stylex.props(styles.camera)} data-testid="drive-camera-kind" ref={cameraRef}>
          chase
        </span>
        <span {...stylex.props(styles.surface)} data-testid="drive-surface" ref={surfaceRef} />
      </div>

      <div {...stylex.props(driveChrome.interactive, styles.toggles)}>
        <DrivePill
          active={trafficEnabled}
          data-testid="drive-traffic-toggle"
          onClick={onToggleTraffic}
        >
          Traffic {trafficEnabled ? "on" : "off"}
        </DrivePill>
        <DrivePill data-testid="drive-units-toggle" onClick={onToggleUnits}>
          {units === "kmh" ? "km/h" : "mph"}
        </DrivePill>
        <DrivePill data-testid="drive-pause" onClick={onPause}>
          Esc
        </DrivePill>
      </div>

      {debug ? (
        <span
          {...stylex.props(driveChrome.panelReadout, styles.debug)}
          data-testid="drive-debug"
          ref={debugRef}
        />
      ) : null}

      <div {...stylex.props(styles.minimapSlot)}>
        <Minimap lanes={lanes} ref={minimapRef} />
      </div>

      <div {...stylex.props(styles.instruments)}>
        <div {...stylex.props(styles.gMeter)} data-testid="drive-gmeter">
          <div {...stylex.props(driveChrome.panelDial, styles.dial)}>
            <div {...stylex.props(styles.crosshairVertical)} />
            <div {...stylex.props(styles.crosshairHorizontal)} />
            <div {...stylex.props(styles.gDot)} ref={gDotRef} />
          </div>
          <span {...stylex.props(driveChrome.monoMicro, styles.gReadout)} ref={gReadoutRef}>
            0.00 g
          </span>
        </div>

        <div {...stylex.props(styles.tachometer)}>
          <svg {...stylex.props(styles.arc)} viewBox="0 0 120 120">
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
          <div {...stylex.props(styles.speedStack)}>
            <span {...stylex.props(styles.speed)} data-testid="drive-speed" ref={speedRef}>
              0
            </span>
            <span {...stylex.props(styles.speedUnits)}>
              {units === "kmh" ? "km/h" : "mph"}
            </span>
          </div>
          <span {...stylex.props(styles.gear)} data-testid="drive-gear" ref={gearRef}>
            N
          </span>
          <span
            {...stylex.props(driveChrome.monoMicro, styles.rpm)}
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
