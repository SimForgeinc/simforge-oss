/**
 * Per-family tuning: the numbers that describe how a car of this kind sounds,
 * separately from the recordings it is built out of.
 *
 * The sample ladder in `samples.ts` is generated from the source recordings and
 * is replaced whenever the library is rebuilt; these values are authored, and a
 * new recording of the same family should not change them.
 */
import type { VehicleAudioClass } from './classes';

export interface EngineProfile {
  /** Engine speed at rest. Telemetry idles here; the graph never plays below it. */
  readonly idleRpm: number;
  /** Engine speed the gearbox shifts at, i.e. the top of the loudness curve. */
  readonly redlineRpm: number;
  /** Overall engine level, relative to the other layers. */
  readonly engineGain: number;
  /**
   * How much of the engine level comes from load rather than speed. A diesel
   * under load changes character far more than it changes pitch; a small petrol
   * engine is closer to being a function of RPM alone.
   */
  readonly loadWeight: number;
  /**
   * Exhaust brightness at full load, Hz. The engine bus runs through a low-pass
   * that opens with load, which is what makes a lifted throttle audible even
   * where the family has no recorded overrun bands.
   */
  readonly brightHz: number;
  /** The same low-pass on a closed throttle. */
  readonly darkHz: number;
  /** Level of the tyre/wind layers for this body, which scales with its size. */
  readonly bodyGain: number;
  /** Gear-shift transient level; an electric drivetrain has no shift at all. */
  readonly shiftGain: number;
}

export const ENGINE_PROFILES: Readonly<Record<VehicleAudioClass, EngineProfile>> = {
  'petrol-i4': {
    idleRpm: 800,
    redlineRpm: 6200,
    engineGain: 0.62,
    loadWeight: 0.45,
    brightHz: 9000,
    darkHz: 2200,
    bodyGain: 1,
    shiftGain: 0.5,
  },
  v8: {
    idleRpm: 650,
    redlineRpm: 6000,
    engineGain: 0.78,
    loadWeight: 0.5,
    brightHz: 11000,
    darkHz: 2400,
    bodyGain: 1.05,
    shiftGain: 0.62,
  },
  'diesel-truck': {
    idleRpm: 600,
    redlineRpm: 2600,
    engineGain: 0.8,
    loadWeight: 0.68,
    brightHz: 6000,
    darkHz: 1400,
    bodyGain: 1.25,
    shiftGain: 0.8,
  },
  bus: {
    idleRpm: 600,
    redlineRpm: 2400,
    engineGain: 0.72,
    loadWeight: 0.62,
    brightHz: 5200,
    darkHz: 1300,
    bodyGain: 1.2,
    shiftGain: 0.7,
  },
  ev: {
    // No combustion: "RPM" is the motor speed the drive unit whines at, and it
    // runs to the top of its range in a single ratio, so there is no shift and
    // no idle — the whine falls silent with the car.
    idleRpm: 0,
    redlineRpm: 12000,
    engineGain: 0.34,
    loadWeight: 0.75,
    brightHz: 14000,
    darkHz: 5000,
    bodyGain: 1,
    shiftGain: 0,
  },
  motorcycle: {
    idleRpm: 1000,
    redlineRpm: 9500,
    engineGain: 0.7,
    loadWeight: 0.4,
    brightHz: 12000,
    darkHz: 2600,
    bodyGain: 0.72,
    shiftGain: 0.55,
  },
};

/** Low-pass cutoff the whole mix runs through, per camera. */
export interface CameraAcoustics {
  /** Cabin low-pass, Hz. `Infinity`-ish values mean "open air". */
  readonly cutoffHz: number;
  /** Wind and tyre layers, scaled: a closed cabin hides them. */
  readonly bodyScale: number;
  /** Engine layer, scaled: the hood camera sits on top of the engine. */
  readonly engineScale: number;
}

export type DriveCamera = 'chase' | 'hood' | 'cockpit' | 'orbit';

export const CAMERA_ACOUSTICS: Readonly<Record<DriveCamera, CameraAcoustics>> = {
  chase: { cutoffHz: 18000, bodyScale: 1, engineScale: 1 },
  hood: { cutoffHz: 18000, bodyScale: 0.85, engineScale: 1.25 },
  cockpit: { cutoffHz: 900, bodyScale: 0.7, engineScale: 0.8 },
  orbit: { cutoffHz: 18000, bodyScale: 0.9, engineScale: 0.9 },
};
